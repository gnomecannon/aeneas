import "fake-indexeddb/auto";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { TASK_GROUP_PROBLEMS } from "@everythingapp/shared";
import { keepSources } from "../lib/sources";
import { TASK_GROUP_TEXT, TaskGroupEditor } from "../components/TaskGroupEditor";
import { LIST_CHOOSER_TEXT } from "../components/ListChooser";
import { Tasks } from "./Tasks";

const swift = fs.readFileSync(path.join(__dirname, "../../../apple/Packages/EACore/Sources/EACore/TaskLists.swift"), "utf8");
const TODO = { key: "icloud:iCloud/To-Do", title: "To-Do", account: "iCloud", kind: "icloud", on: true, space: "personal" as const };
const HOMEWORK = { key: "exchange:School/Homework", title: "Homework", account: "School", kind: "exchange", on: true, space: "work" as const };
const SCHOOL = { id: "school", name: "School", lists: [HOMEWORK.key] };

describe("task groups on Tasks (gnomecannon/aeneas#26)", () => {
  afterEach(() => keepSources(null));

  it("say the same words as the Apple apps", () => {
    for (const text of Object.values(TASK_GROUP_TEXT)) expect(swift, text).toContain(`"${text}"`);
    for (const text of Object.values(TASK_GROUP_PROBLEMS)) expect(swift, text).toContain(`"${text}"`);
  });

  it("are kept from the hub's answer and a cached copy, and a set that breaks a rule is dropped", () => {
    keepSources({ lists: [TODO, HOMEWORK], groups: [SCHOOL] } as never);
    const html = renderToStaticMarkup(createElement(Tasks));
    expect(html).toContain('role="tablist" aria-label="Show"');
    expect(html).toMatch(/role="tab" aria-selected="true" class="on">Personal<\/button><button type="button" role="tab" aria-selected="false" class="">School<\/button>/);
    expect(html).toContain(">New group</button>");
    expect(html).not.toContain(">Edit group</button>");
    keepSources({ lists: [TODO], groups: [SCHOOL, { ...SCHOOL, id: "school-2" }] } as never);
    expect(renderToStaticMarkup(createElement(Tasks))).not.toContain(">School<");
  });

  it("offer New group only once there are lists, and no selector with Personal alone", () => {
    keepSources({ lists: [] } as never);
    const none = renderToStaticMarkup(createElement(Tasks));
    expect(none).not.toContain("tablist");
    expect(none).not.toContain("New group");
    keepSources({ lists: [TODO] } as never);
    const lists = renderToStaticMarkup(createElement(Tasks));
    expect(lists).not.toContain('aria-label="Show"');
    expect(lists).toContain(">New group</button>");
  });

  it("are edited with a name, a box for each list that is on and one for no list, and Delete group", () => {
    const edit = renderToStaticMarkup(createElement(TaskGroupEditor, { group: SCHOOL, groups: [SCHOOL], lists: [TODO, HOMEWORK], onDone: () => {} }));
    expect(edit).toContain(`<h2 style="margin:0">${TASK_GROUP_TEXT.editGroup}</h2>`);
    expect(edit).toContain('value="School"');
    expect(edit).toMatch(/checked=""\/><span class="body"><span class="t">Homework<\/span><span class="meta">School, Work<\/span>/);
    expect(edit).toMatch(/type="checkbox"\/><span class="body"><span class="t">To-Do<\/span><span class="meta">iCloud<\/span>/);
    expect(edit).toContain(LIST_CHOOSER_TEXT.noList);
    expect(edit).toContain(TASK_GROUP_TEXT.note);
    expect(edit).toContain(`>${TASK_GROUP_TEXT.delete}</button>`);
    const made = renderToStaticMarkup(createElement(TaskGroupEditor, { group: null, groups: [], lists: [TODO], onDone: () => {} }));
    expect(made).toContain(`<h2 style="margin:0">${TASK_GROUP_TEXT.newGroup}</h2>`);
    expect(made).toContain(`placeholder="${TASK_GROUP_TEXT.namePlaceholder}"`);
    expect(made).toMatch(/<button class="primary" type="submit" disabled="">Save<\/button>/);
    expect(made).not.toContain(TASK_GROUP_TEXT.delete);
  });
});
