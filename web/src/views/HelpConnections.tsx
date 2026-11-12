/**
 * The full comparison behind the three ways devices reach the hub (Settings and the Welcome page link here from each
 * ⓘ). Plain words, every outside party named, and what each choice cannot protect against.
 */
const ROWS: { label: string; direct: string; tailscale: string; home: string }[] = [
  { label: "Setting up a phone or computer", direct: "Scan the QR code.", tailscale: "Sign in to Tailscale with the same account as the hub (in the Tailscale app, or inside Aeneas on iPhone, iPad and Mac), then scan the QR code.", home: "Scan the QR code while on your home network." },
  { label: "Works away from home", direct: "Yes.", tailscale: "Yes.", home: "No." },
  { label: "Account needed", direct: "None.", tailscale: "A Tailscale account (Google, Apple, Microsoft or GitHub sign-in).", home: "None." },
  { label: "Can anyone read your data on the way?", direct: "No. Encrypted end to end between your device and the hub.", tailscale: "No. Encrypted end to end between your devices (WireGuard).", home: "No. Encrypted with the hub's own certificate." },
  { label: "Outside companies involved", direct: "n0, the makers of iroh, run the relay used when a direct path is blocked. It passes encrypted data and sees IP addresses and timing, not content. n0 offers its relays free but promises no uptime; if they stop, Direct link stops until the app moves to another relay (Tailscale and Home Wi-Fi only are not affected).", tailscale: "Tailscale runs the coordination server and relays. It keeps your account, a list of your devices, their names and when they're online.", home: "None." },
  { label: "Who decides which devices are trusted", direct: "Only you: your devices trust the hub key in the QR code you scanned. A relay can't add a device or pretend to be your hub.", tailscale: "Tailscale's server tells your devices which keys belong to your network. Tailnet Lock moves that decision back to you, but it's off by default.", home: "Only you, through the certificate in the QR code." },
  { label: "If a company is forced to cooperate", direct: "The relay operator could be made to log IP addresses and timing. There's no account or device list to hand over.", tailscale: "Tailscale could be made to hand over your account and device records, and in principle to add a device to your network (unless Tailnet Lock is on).", home: "Nothing outside your home is involved." },
  { label: "Upkeep", direct: "None.", tailscale: "Devices sign in again every 180 days unless you turn key expiry off in Tailscale's admin page.", home: "None." },
  { label: "Cost", direct: "Free for you.", tailscale: "Free for personal use.", home: "Free." },
  { label: "Best for", direct: "Most people.", tailscale: "People who already use Tailscale, or want the hub to reach their other machines.", home: "Keeping everything inside your home." },
];

export default function HelpConnections() {
  return (
    <div className="col help-connections" style={{ maxWidth: 860 }}>
      <h1>How your devices reach your hub</h1>
      <p className="muted">Your hub is a computer in your home. Your phone and other computers need a private way to reach it. This choice decides how. It doesn't change what the hub stores or where your data lives: that always stays on your hub.</p>
      <div className="table-scroll">
        <table className="compare">
          <thead><tr><th></th><th>Direct link (iroh)</th><th>Tailscale</th><th>Home Wi-Fi only</th></tr></thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.label}><th scope="row">{r.label}</th><td>{r.direct}</td><td>{r.tailscale}</td><td>{r.home}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>What none of these can protect against</h2>
      <p>Every choice trusts the Aeneas app itself, your phone or computer's operating system, and any cloud backups of your devices. Aeneas is open source, so anyone can check what the app does.</p>
      <h2>Read more</h2>
      <ul>
        <li><a href="https://iroh.computer" target="_blank" rel="noreferrer">iroh</a>, made by n0 (open source)</li>
        <li><a href="https://tailscale.com/kb/1151/what-is-tailscale" target="_blank" rel="noreferrer">What is Tailscale</a>, and <a href="https://tailscale.com/kb/1226/tailnet-lock" target="_blank" rel="noreferrer">Tailnet Lock</a></li>
      </ul>
      <p><a href="#/settings">Back to Settings</a> · <a href="#/welcome">Back to setup</a></p>
    </div>
  );
}
