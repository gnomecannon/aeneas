use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

const MAIN: &str = "main";
const CAPTURE: &str = "capture";
const WIDGET: &str = "widget";
/// The file in the app config folder that says whether the Now widget was open, so it comes back after a restart.
const WIDGET_FILE: &str = "widget.json";
/// The global Capture shortcut, chosen in Settings: one of SHORTCUTS, or "off". Kept beside the widget state.
const SHORTCUT_FILE: &str = "shortcut.json";
/// The shortcuts Settings offers (the same list on the Mac). Ctrl+Shift+Space is the default on both; Ctrl+Alt is left
/// out on Windows because many keyboard layouts use it as AltGr to type characters.
const SHORTCUTS: [&str; 3] = ["Control+Shift+Space", "Control+Shift+K", "Alt+Shift+Space"];
const DEFAULT_SHORTCUT: &str = "Control+Shift+Space";

/// Numbers pop-out windows: `pop-1`, `pop-2`. The window-state plugin remembers each label's size and place.
static POP_COUNT: AtomicU32 = AtomicU32::new(0);

/// The screen the last notification was about. Clicking a Windows toast starts the app again; the single-instance
/// hook sends that start here, and the running window opens this path.
#[derive(Default)]
struct NotifyTarget {
    path: Option<(String, std::time::Instant)>,
}

const NOTIFY_TARGET_TTL: std::time::Duration = std::time::Duration::from_secs(15 * 60);

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn open_capture<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(CAPTURE) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, CAPTURE, WebviewUrl::App("index.html#/capture?mini=1".into()))
        .title("Capture")
        .inner_size(440.0, 300.0)
        .min_inner_size(320.0, 200.0)
        .always_on_top(true)
        .decorations(false)
        .skip_taskbar(true)
        .center()
        .build();
    if let Ok(w) = built {
        let _ = w.set_focus();
    }
}

fn widget_file<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(WIDGET_FILE))
}

fn remember_widget<R: Runtime>(app: &AppHandle<R>, open: bool) {
    if let Some(p) = widget_file(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, format!("{{\"open\":{}}}\n", open));
    }
}

fn widget_remembered<R: Runtime>(app: &AppHandle<R>) -> bool {
    widget_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("open").and_then(|o| o.as_bool()))
        .unwrap_or(false)
}

/// The Now widget: a small window that stays on top with the Now task, a running activity and Capture.
/// It opens where it was last left (the window-state plugin restores every window it has seen).
fn open_widget<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(WIDGET) {
        let _ = w.show();
    } else {
        let _ = WebviewWindowBuilder::new(app, WIDGET, WebviewUrl::App("index.html#/widget".into()))
            .title("Now")
            .inner_size(320.0, 210.0)
            .min_inner_size(240.0, 150.0)
            .always_on_top(true)
            .decorations(false)
            .skip_taskbar(true)
            .build();
    }
    remember_widget(app, true);
    let _ = app.emit("widget-changed", true);
}

fn close_widget<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(WIDGET) {
        let _ = w.close();
    }
    remember_widget(app, false);
    let _ = app.emit("widget-changed", false);
}

#[tauri::command]
fn set_widget(app: AppHandle, open: bool) {
    if open {
        open_widget(&app);
    } else {
        close_widget(&app);
    }
}

fn shortcut_file<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(SHORTCUT_FILE))
}

/// The chosen Capture shortcut: one of SHORTCUTS, "off", or the default when nothing was chosen yet.
fn shortcut_remembered<R: Runtime>(app: &AppHandle<R>) -> String {
    shortcut_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("shortcut").and_then(|s| s.as_str()).map(|s| s.to_string()))
        .filter(|s| s == "off" || SHORTCUTS.contains(&s.as_str()))
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string())
}

/// Registers the chosen shortcut and nothing else. "off" leaves none.
#[cfg(desktop)]
fn apply_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    if shortcut != "off" {
        gs.register(shortcut).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Settings, This computer: the global Capture shortcut. Kept for the next start.
#[tauri::command]
fn set_capture_shortcut(app: AppHandle, shortcut: String) -> Result<String, String> {
    if shortcut != "off" && !SHORTCUTS.contains(&shortcut.as_str()) {
        return Err("not one of the offered shortcuts".into());
    }
    #[cfg(desktop)]
    apply_shortcut(&app, &shortcut)?;
    if let Some(p) = shortcut_file(&app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, serde_json::json!({ "shortcut": shortcut }).to_string());
    }
    Ok(shortcut)
}

#[tauri::command]
fn get_capture_shortcut(app: AppHandle) -> String {
    shortcut_remembered(&app)
}

#[tauri::command]
fn get_widget(app: AppHandle) -> bool {
    app.get_webview_window(WIDGET).is_some()
}

#[tauri::command]
fn show_main_window(app: AppHandle, path: Option<String>) {
    show_main(&app);
    if let Some(p) = path {
        let _ = app.emit_to(MAIN, "navigate", p);
    }
}

#[tauri::command]
fn open_capture_window(app: AppHandle) {
    open_capture(&app);
}

/// A screen in a window of its own, for a second monitor: `path` is the app route, shown without the sidebar.
#[tauri::command]
fn open_window(app: AppHandle, path: String, title: String) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("path must start with /".into());
    }
    let n = POP_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    let sep = if path.contains('?') { '&' } else { '?' };
    let url = format!("index.html#{}{}pop=1", path, sep);
    WebviewWindowBuilder::new(&app, format!("pop-{}", n), WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(560.0, 720.0)
        .min_inner_size(320.0, 240.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_notify_target(state: tauri::State<'_, Mutex<NotifyTarget>>, path: String) {
    if let Ok(mut t) = state.lock() {
        t.path = Some((path, std::time::Instant::now()));
    }
}

/// A second start of the app (a toast click, or the user opening it again): bring the window forward and, when a
/// notification was sent recently, open what it was about.
fn on_second_start<R: Runtime>(app: &AppHandle<R>, args: Vec<String>) {
    if args.iter().any(|a| a == "--minimized") {
        return;
    }
    show_main(app);
    let target = app
        .try_state::<Mutex<NotifyTarget>>()
        .and_then(|s| s.lock().ok().and_then(|mut t| t.path.take()));
    if let Some((path, at)) = target {
        if at.elapsed() < NOTIFY_TARGET_TTL {
            let _ = app.emit_to(MAIN, "navigate", path);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // Must be the first plugin, so a second start is caught before anything else runs.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| on_second_start(app, args)));
    }
    builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(Mutex::new(NotifyTarget::default()))
        .invoke_handler(tauri::generate_handler![set_widget, get_widget, show_main_window, open_capture_window, open_window, set_notify_target, set_capture_shortcut, get_capture_shortcut]);

    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::ShortcutState;
        builder = builder.plugin(
            // The shortcut itself is registered in setup, from Settings (or the default).
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        open_capture(app);
                    }
                })
                .build(),
        );
    }

    builder
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let capture = MenuItem::with_id(app, "capture", "Capture", true, None::<&str>)?;
            let widget = CheckMenuItem::with_id(app, "widget", "Now widget", true, widget_remembered(app.handle()), None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &capture, &widget, &quit])?;

            let widget_for_event = widget.clone();
            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("EverythingApp")
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "capture" => open_capture(app),
                    "widget" => {
                        let checked = widget_for_event.is_checked().unwrap_or(false);
                        set_widget(app.clone(), checked);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Keep the tray check item in step when the widget is opened or closed from Settings or the widget itself.
            let widget_for_listener = widget.clone();
            let handle = app.handle().clone();
            handle.listen("widget-changed", move |e| {
                if let Ok(v) = serde_json::from_str::<bool>(e.payload()) {
                    let _ = widget_for_listener.set_checked(v);
                }
            });
            if widget_remembered(app.handle()) {
                open_widget(app.handle());
            }
            #[cfg(desktop)]
            {
                let chosen = shortcut_remembered(app.handle());
                // Taken by another app: the app still starts, and Settings can pick another.
                let _ = apply_shortcut(app.handle(), &chosen);
            }

            // Start minimized to tray when launched by autostart.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window(MAIN) {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window hides it to the tray; Quit in the tray menu exits.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                } else if window.label() == CAPTURE {
                    api.prevent_close();
                    let _ = window.hide();
                } else if window.label() == WIDGET {
                    // Closed by hand (Alt+F4): it stays closed after a restart too.
                    remember_widget(window.app_handle(), false);
                    let _ = window.app_handle().emit("widget-changed", false);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running EverythingApp");
}
