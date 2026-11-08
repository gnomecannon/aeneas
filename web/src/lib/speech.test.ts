import { describe, expect, it } from "vitest";
import { speakableText } from "./speech";

describe("speakableText", () => {
  it("drops markdown marks and keeps the words", () => {
    expect(speakableText("## Plan\n**Restart** the *service*, then check `systemctl status`.")).toBe("Plan\nRestart the service, then check systemctl status.");
  });

  it("names code blocks instead of reading them", () => {
    expect(speakableText("Run this:\n```sh\nsudo zfs scrub tank\n```\nThen wait.")).toBe("Run this:\n (code block) \nThen wait.");
  });

  it("reads link text, not addresses", () => {
    expect(speakableText("See [the runbook](https://core/x) or https://example.com/a?b=c.")).toBe("See the runbook or a link");
  });

  it("drops list markers and quote marks", () => {
    expect(speakableText("- one\n- two\n1. three\n> note")).toBe("one\ntwo\nthree\nnote");
  });

  it("leaves snake_case and file names alone", () => {
    expect(speakableText("Edit backup_now.sh and my_var.")).toBe("Edit backup_now.sh and my_var.");
  });
});
