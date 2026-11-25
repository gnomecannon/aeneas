import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CHOSEN_LISTS, MAX_TASK_GROUPS, NO_LIST, TASK_GROUP_PROBLEMS, defaultToday, isListChoice, listChosen, newTaskGroupId, readListChoices,
  readTaskGroups, readToday, taskGroupsProblem, taskInLists, todayMove, todayTodoLists, todayWithOrder, todayWithShown, todayWithTodoLists,
  withListChosen, withNoListChosen, withTaskGroup, withoutTaskGroup, type TaskGroup,
} from "../src/index.ts";

// The same cases as EACore TaskListsTests.swift: the two sides choose the same tasks.
const TODO = { key: "icloud:iCloud/To-Do", title: "To-Do" };
const SHOP = { key: "icloud:iCloud/Shopping", title: "Shopping", was: ["icloud:iCloud/Groceries"] };
const HOMEWORK = { key: "exchange:School/Homework", title: "Homework" };
const HOMEWORK_TOO = { key: "icloud:iCloud/Homework", title: "Homework" };
const LISTS = [TODO, SHOP, HOMEWORK, HOMEWORK_TOO];
const apple = (a: Record<string, unknown>) => ({ title: "x", apple: { id: "r1", list: "L1", ...a } });

test("lists: a task is in the choice by its list's key, an older key, or its list's name", () => {
  const inTodo = taskInLists([TODO.key], LISTS);
  assert.equal(inTodo(apple({ list_key: TODO.key, list_title: "To-Do" })), true);
  assert.equal(inTodo(apple({ list_key: SHOP.key, list_title: "Shopping" })), false);
  // Linked before lists had keys: by its list's name.
  assert.equal(inTodo(apple({ list_title: "To-Do" })), true);
  assert.equal(inTodo(apple({ list_title: "Shopping" })), false);
  // Made in Aeneas inside a list, not yet added to Reminders: by the name too.
  assert.equal(inTodo({ title: "x", apple: { id: "", list: "", list_title: "To-Do" } }), true);
  // In no list: only when the choice names `none`.
  assert.equal(inTodo({ title: "Water the plants" }), false);
  assert.equal(inTodo({ title: "x", apple: { id: "", list: "" } }), false);
  assert.equal(taskInLists([TODO.key, NO_LIST], LISTS)({ title: "Water the plants" }), true);
  assert.equal(taskInLists([NO_LIST], LISTS)(apple({ list_key: TODO.key, list_title: "To-Do" })), false);
  // A key from before the list was renamed finds it by `was`, and a choice made under the old key still holds.
  assert.equal(taskInLists([SHOP.key], LISTS)(apple({ list_key: "icloud:iCloud/Groceries" })), true);
  assert.equal(taskInLists(["icloud:iCloud/Groceries"], LISTS)(apple({ list_key: SHOP.key, list_title: "Shopping" })), true);
  // A key whose list now has another name: an older app changed only the title, so the title decides.
  assert.equal(inTodo(apple({ list_key: SHOP.key, list_title: "To-Do" })), true);
  assert.equal(inTodo(apple({ list_key: TODO.key, list_title: "Shopping" })), false);
  // A name two accounts share: in the choice when either list is.
  assert.equal(taskInLists([HOMEWORK.key], LISTS)(apple({ list_title: "Homework" })), true);
  assert.equal(taskInLists([HOMEWORK_TOO.key], LISTS)(apple({ list_title: "Homework" })), true);
  assert.equal(taskInLists([HOMEWORK.key], LISTS)(apple({ list_key: HOMEWORK_TOO.key, list_title: "Homework" })), false);
  // A list the setting has not heard of counts when the choice names its key, and not by its name alone.
  assert.equal(taskInLists(["caldav:Google/Errands"], LISTS)(apple({ list_key: "caldav:Google/Errands", list_title: "Errands" })), true);
  assert.equal(taskInLists(["caldav:Google/Errands"], LISTS)(apple({ list_title: "Errands" })), false);
  assert.equal(taskInLists(["caldav:Google/Errands"], undefined)(apple({ list_key: "caldav:Google/Errands" })), true);
  // Nothing chosen: no task.
  assert.equal(taskInLists([], LISTS)({ title: "x" }), false);
  assert.equal(taskInLists([], LISTS)(apple({ list_key: TODO.key })), false);
});

test("lists: a choice keeps its rules, and is changed one list at a time", () => {
  assert.deepEqual(readListChoices([]), []);
  assert.deepEqual(readListChoices([TODO.key, NO_LIST]), [TODO.key, NO_LIST]);
  assert.ok(readListChoices(Array.from({ length: MAX_CHOSEN_LISTS }, (_, i) => `icloud:iCloud/L${i}`)));
  for (const bad of [null, "none", {}, [TODO.key, TODO.key], ["ab"], [7], ["x".repeat(301)], Array.from({ length: MAX_CHOSEN_LISTS + 1 }, (_, i) => `icloud:iCloud/L${i}`)]) {
    assert.equal(readListChoices(bad), null, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(isListChoice(NO_LIST), true);
  assert.equal(isListChoice("x".repeat(300)), true);

  let c: string[] = ["icloud:iCloud/Groceries", "local:On My iPhone/Packing"];
  assert.equal(listChosen(c, SHOP), true, "by the key it had before a rename");
  c = withListChosen(c, SHOP, false);
  assert.deepEqual(c, ["local:On My iPhone/Packing"], "taken out with its older keys; a list not shown here stays");
  c = withListChosen(c, TODO, true);
  c = withListChosen(c, TODO, true);
  assert.deepEqual(c, ["local:On My iPhone/Packing", TODO.key], "added once");
  c = withNoListChosen(c, true);
  assert.deepEqual(withNoListChosen(c, true), c);
  assert.deepEqual(withNoListChosen(c, false), ["local:On My iPhone/Packing", TODO.key]);
});

test("today: the To do card's lists are part of Today's setting, and every edit keeps them", () => {
  const s = { order: ["now", "todo"], hidden: [], todo_lists: [TODO.key, NO_LIST] };
  assert.deepEqual(readToday(s), s);
  assert.deepEqual(readToday({ order: [], hidden: [], todo_lists: null }), { order: [], hidden: [], todo_lists: null }, "null asks for every list");
  assert.deepEqual(readToday({ order: [], hidden: [] }), { order: [], hidden: [] }, "absent says nothing");
  assert.deepEqual(readToday({ order: [], hidden: [], todo_lists: [] }), { order: [], hidden: [], todo_lists: [] }, "nothing chosen");
  for (const bad of ["none", [TODO.key, TODO.key], ["ab"], {}]) assert.equal(readToday({ order: [], hidden: [], todo_lists: bad }), null, JSON.stringify(bad));
  assert.equal(todayTodoLists(defaultToday()), null);
  assert.equal(todayTodoLists({ order: [], hidden: [], todo_lists: null }), null);
  assert.deepEqual(todayTodoLists(s), [TODO.key, NO_LIST]);
  // Moving, showing and hiding keep the choice; an edit of a setting that says nothing adds nothing.
  assert.deepEqual(todayMove(s, "coming", 0).todo_lists, [TODO.key, NO_LIST]);
  assert.deepEqual(todayWithShown(s, "todo", false).todo_lists, [TODO.key, NO_LIST]);
  assert.deepEqual(todayWithOrder(s, ["todo"]).todo_lists, [TODO.key, NO_LIST]);
  assert.equal("todo_lists" in todayMove(defaultToday(), "coming", 0), false);
  // Choosing names the lists, or null for every list, so the hub hears the change.
  const chosen = todayWithTodoLists(defaultToday(), [TODO.key]);
  assert.deepEqual(chosen.todo_lists, [TODO.key]);
  assert.deepEqual(chosen.order, defaultToday().order);
  assert.equal(todayWithTodoLists(chosen, null).todo_lists, null);
  assert.ok(readToday(todayWithTodoLists(chosen, null)));
});

test("groups: what a set of task groups must be, in the words the screens show", () => {
  const school: TaskGroup = { id: "school", name: "School", lists: [HOMEWORK.key, "icloud:iCloud/Reading"] };
  const home: TaskGroup = { id: "home", name: "Home", lists: [SHOP.key, NO_LIST] };
  assert.equal(taskGroupsProblem([]), null);
  assert.equal(taskGroupsProblem([school, home]), null);
  assert.equal(taskGroupsProblem([{ ...school, lists: [] }]), null, "a group with no lists yet");
  assert.deepEqual(readTaskGroups([{ ...school, name: "  School " }]), [school], "names are kept trimmed");
  assert.deepEqual(readTaskGroups([{ ...school, extra: 1 }]), [school], "only the three fields are kept");
  const many = Array.from({ length: MAX_TASK_GROUPS }, (_, i) => ({ id: `g${i}`, name: `Group ${i}`, lists: [] }));
  assert.equal(taskGroupsProblem(many), null);
  const cases: Array<[unknown, string]> = [
    [null, TASK_GROUP_PROBLEMS.shape],
    [{}, TASK_GROUP_PROBLEMS.shape],
    [[null], TASK_GROUP_PROBLEMS.shape],
    [[{ id: "school", name: "School" }], TASK_GROUP_PROBLEMS.shape],
    [[{ id: "school", lists: [] }], TASK_GROUP_PROBLEMS.shape],
    [[...many, { id: "one-more", name: "One more", lists: [] }], TASK_GROUP_PROBLEMS.tooMany],
    [[{ ...school, id: "School" }], TASK_GROUP_PROBLEMS.id],
    [[{ ...school, id: "" }], TASK_GROUP_PROBLEMS.id],
    [[{ ...school, id: "x".repeat(41) }], TASK_GROUP_PROBLEMS.id],
    [[school, { ...home, id: "school" }], TASK_GROUP_PROBLEMS.id],
    [[{ ...school, name: "   " }], TASK_GROUP_PROBLEMS.noName],
    [[{ ...school, name: "x".repeat(41) }], TASK_GROUP_PROBLEMS.longName],
    [[{ ...school, name: " work " }], TASK_GROUP_PROBLEMS.reserved],
    [[{ ...school, name: "PERSONAL" }], TASK_GROUP_PROBLEMS.reserved],
    [[school, { ...home, name: "school " }], TASK_GROUP_PROBLEMS.taken],
    [[{ ...school, lists: [HOMEWORK.key, HOMEWORK.key] }], TASK_GROUP_PROBLEMS.lists],
    [[{ ...school, lists: ["ab"] }], TASK_GROUP_PROBLEMS.lists],
    [[{ ...school, lists: "none" }], TASK_GROUP_PROBLEMS.shape],
  ];
  for (const [raw, problem] of cases) {
    assert.equal(taskGroupsProblem(raw), problem, JSON.stringify(raw).slice(0, 80));
    assert.equal(readTaskGroups(raw), null);
  }
  // A name of 40 characters is fine, counted as characters, not as UTF-16 units.
  assert.equal(taskGroupsProblem([{ ...school, name: "é".repeat(40) }]), null);
  assert.equal(taskGroupsProblem([{ ...school, name: "📚".repeat(40) }]), null);
});

test("groups: ids for new groups, and adding, renaming and deleting one", () => {
  const school: TaskGroup = { id: "school", name: "School", lists: [] };
  assert.equal(newTaskGroupId("School", []), "school");
  assert.equal(newTaskGroupId("School", [school]), "school-2");
  assert.equal(newTaskGroupId("School", [school, { ...school, id: "school-2" }]), "school-3");
  assert.equal(newTaskGroupId("École & Art!", []), "ecole-art");
  assert.equal(newTaskGroupId("📚", []), "group");
  assert.equal(newTaskGroupId("a".repeat(29) + " b", []), "a".repeat(29));
  let groups = withTaskGroup([], school);
  groups = withTaskGroup(groups, { id: "home", name: "Home", lists: [NO_LIST] });
  groups = withTaskGroup(groups, { ...school, name: "Classes", lists: [HOMEWORK.key] });
  assert.deepEqual(groups.map((g) => g.name), ["Classes", "Home"], "renamed in its place");
  assert.deepEqual(withoutTaskGroup(groups, "school").map((g) => g.id), ["home"]);
  // A group shows the tasks of its lists, whichever space they are in.
  const inSchool = taskInLists(groups[0].lists, LISTS);
  assert.equal(inSchool(apple({ list_key: HOMEWORK.key, list_title: "Homework" })), true);
  assert.equal(inSchool(apple({ list_key: TODO.key, list_title: "To-Do" })), false);
  assert.equal(inSchool({ title: "Water the plants" }), false);
});
