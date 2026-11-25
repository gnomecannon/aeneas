/** Hash route for an entity of a given kind, used by search hits, Capture results and the Status friction list.
 * `title` narrows screens that list many items (games, films) to the one found. */
export function linkFor(kind: string, id: string, title?: string): string {
  const q = title ? `?q=${encodeURIComponent(title)}` : "";
  switch (kind) {
    case "note":
      return `#/notes/${id}`;
    case "task":
      return `#/tasks?focus=${id}`;
    case "reminder":
      // Reminders are tasks now; an older reminder link lands on Tasks.
      return `#/tasks?focus=${id}`;
    case "person":
      return `#/people/${id}`;
    // Kinds whose screen lists many items without selecting one open on their own page.
    case "capture":
    case "fact":
    case "log":
    case "event":
    case "food_option":
    case "pet_event":
    case "image":
      return `#/item/${id}`;
    case "rule":
      return "#/memory";
    case "ledger":
      return "#/assistant";
    case "watch":
      return `#/renewals?focus=${id}`;
    case "plan_rule":
      return "#/plan-rules";
    case "project":
      return `#/projects/${id}`;
    case "inventory":
      return "#/projects/inventory";
    case "procedure":
      return `#/procedures/${id}`;
    case "music_idea":
      return `#/music/${id}`;
    case "quiz":
      return "#/quiz";
    case "journal":
      return `#/journal?focus=${id}`;
    case "snippet":
      return `#/snippets/${id}`;
    case "runbook":
      return `#/hosts?runbook=${id}`;
    case "monitor":
    case "incident":
      return `#/ops?focus=${id}`;
    case "sensor":
    case "reading":
      return "#/sensors";
    case "checklist":
      return `#/lists/${id}`;
    case "game":
      return `#/games${q}`;
    case "film":
      return `#/films${q}`;
    case "music_profile":
      return "#/listening";
    case "invitation":
      return "#/week?invitations=1";
    case "device":
      return "#/settings";
    default:
      return "#/today";
  }
}

/** A kind as people say it ("fix notes", not "runbook"). */
export const KIND_LABELS: Record<string, string> = {
  capture: "inbox", note: "note", task: "task", reminder: "reminder", event: "event", log: "health log", fact: "memory", rule: "rule",
  runbook: "fix notes", ledger: "troubleshooting", project: "project", device: "device", watch: "renewal", plan_rule: "plan rule",
  journal: "change journal", snippet: "snippet", pet_event: "pet", sensor: "sensor", reading: "reading", food_option: "food",
  inventory: "inventory", procedure: "procedure", music_idea: "music idea", quiz: "quiz", monitor: "monitor", incident: "incident",
  checklist: "list", game: "game", film: "film", person: "person", image: "image",
  music_profile: "Apple Music taste", invitation: "invitation",
};
export const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

/** A device's platform as people say it ("iPhone", not "iphone"). */
const PLATFORM_LABEL: Record<string, string> = {
  iphone: "iPhone", ipad: "iPad", mac: "Mac", watch: "Watch", windows: "Windows", web: "Web",
};
export const platformLabel = (platform: string) => PLATFORM_LABEL[platform] ?? platform;
/** Where a capture came from, as people say it (Unsorted Info): a device, or a Shortcut, Voice or the API (EACore `Source.label`). */
export const captureSourceLabel = (source: string) => ({ shortcut: "Shortcut", voice: "Voice", api: "API" } as Record<string, string>)[source] ?? platformLabel(source);
