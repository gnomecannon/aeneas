import { useEffect, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { initialQuiz, quizCounts, quizStep, type QuizAction, type QuizF, type QuizState } from "../lib/creative";

/**
 * Tonight's recall quiz, one question at a time and no answer key. "I know it" marks right. "Not sure"
 * shows the hint for one more try, then "Reveal" marks revealed. "Wrong" marks wrong.
 */
export function Quiz() {
  const [quiz, setQuiz] = useState<Entity | null | undefined>(undefined);
  const [state, setState] = useState<QuizState | null>(null);
  const [streak, setStreak] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  useEffect(() => {
    const c = engine.client;
    if (!c) {
      setErr("Needs the hub.");
      setQuiz(null);
      return;
    }
    let alive = true;
    c.quizToday()
      .then((q) => {
        if (!alive) return;
        setQuiz(q);
        if (q) setState(initialQuiz((q.fields as QuizF).items));
      })
      .catch((e) => {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : String(e));
        setQuiz(null);
      });
    c.status()
      .then((s) => alive && setStreak(s.creative?.quiz_streak_days ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const act = async (action: QuizAction) => {
    if (!quiz || !state || busy) return;
    const f = quiz.fields as QuizF;
    const { state: next, record } = quizStep(state, action);
    if (action === "reveal" && record) setRevealed(f.items[record.index].a);
    else setRevealed(null);
    setState(next);
    if (!record) return;
    setBusy(true);
    setErr("");
    try {
      const out = await engine.client!.quizAnswer(quiz.id, record.index, record.result);
      setQuiz(out);
      if (next.phase === "done") {
        const s = await engine.client!.status().catch(() => null);
        if (s) setStreak(s.creative?.quiz_streak_days ?? null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const streakLine = streak == null ? null : <div className="muted small">{streak === 0 ? "No streak yet." : `${streak} day streak.`}</div>;

  const build = async () => {
    const c = engine.client;
    if (!c) return;
    setBuilding(true);
    setErr("");
    try {
      const q = await c.quizBuild();
      if (!q) setErr("Nothing to ask from today's chats yet.");
      setQuiz(q);
      if (q) setState(initialQuiz((q.fields as QuizF).items));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  };

  if (quiz === undefined) return <div className="empty">Loading</div>;
  if (!quiz || !state) {
    return (
      <div className="quiz">
        <h1>Recall quiz</h1>
        <div className="card big">
          <div className="title">No quiz yet today</div>
          <div className="muted">It is made from today's assistant chats when you ask, so the model runs only then.</div>
          <div style={{ marginTop: 8 }}>
            <button className="primary" disabled={building || !engine.client} onClick={() => void build()}>{building ? "Making it" : "Make today's quiz"}</button>
          </div>
          {streakLine}
          {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
        </div>
      </div>
    );
  }

  const f = quiz.fields as QuizF;
  const counts = quizCounts(state.results);
  const item = f.items[state.index];

  return (
    <div className="quiz">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Recall quiz</h1>
        <span className="muted small">{f.date}</span>
      </div>
      {state.phase === "done" ? (
        <div className="card big" style={{ marginTop: 12 }}>
          <div className="title">Done</div>
          <div className="counts">
            <span className="ok">{counts.right} right</span>
            <span className="warn">{counts.revealed} revealed</span>
            <span className="muted">{counts.wrong} wrong</span>
          </div>
          {revealed && (
            <div className="muted small" style={{ marginTop: 8 }}>
              Last answer: {revealed}
            </div>
          )}
          <div style={{ marginTop: 8 }}>{streakLine}</div>
        </div>
      ) : (
        <div className="card big question" style={{ marginTop: 12 }}>
          <div className="muted small progress">
            {counts.answered + 1} of {counts.total}
            {item.topic ? `, ${item.topic}` : ""}
          </div>
          {revealed && (
            <div className="muted small" style={{ marginBottom: 8 }}>
              Last answer: {revealed}
            </div>
          )}
          <div className="title">{item.q}</div>
          {state.phase === "hint" && (
            <div className="callout hint" role="note" aria-label="Hint">
              {item.hint || "No hint for this one."}
            </div>
          )}
          {err && <div className="error">{err}</div>}
          <div className="actions quiz-actions">
            <button className="primary" onClick={() => void act("know")} disabled={busy}>
              I know it
            </button>
            {state.phase === "ask" ? (
              <button onClick={() => void act("unsure")} disabled={busy}>
                Not sure
              </button>
            ) : (
              <button onClick={() => void act("reveal")} disabled={busy}>
                Reveal
              </button>
            )}
            <button className="ghost" onClick={() => void act("wrong")} disabled={busy}>
              Wrong
            </button>
          </div>
        </div>
      )}
      {streak != null && state.phase !== "done" && streakLine}
    </div>
  );
}
