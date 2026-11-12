'use strict';
// Выполняет шаги установки по очереди. Если шаг упал, откатывает уже сделанные.

function sanitize(text, secrets = []) {
  return secrets.filter(Boolean).reduce((out, s) => out.split(s).join('***'), String(text));
}

async function runSteps(steps, ctx, onProgress) {
  const done = [];
  const report = (id, title, state, detail) => onProgress({
    id, title, state, ...(detail ? { detail: sanitize(detail, ctx.secrets) } : {}),
  });

  for (const step of steps) {
    report(step.id, step.title, 'run');
    try {
      await step.run(ctx);
      done.push(step);
      report(step.id, step.title, 'ok');
    } catch (err) {
      const error = sanitize(err.message, ctx.secrets);
      report(step.id, step.title, 'fail', error);
      // Такой шаг мог успеть что-то записать, поэтому откатывается и сам.
      if (step.undoOnFail) done.push(step);
      for (const prev of done.reverse()) {
        if (!prev.undo) continue;
        report(prev.id, prev.title, 'undo');
        try {
          await prev.undo(ctx);
        } catch (undoErr) {
          // Откат идёт дальше: один сбой не должен оставить остальные шаги неотменёнными.
          report(prev.id, prev.title, 'undo-failed', undoErr.message);
        }
      }
      return { ok: false, failedStep: step.id, error };
    }
  }
  return { ok: true };
}

module.exports = { runSteps, sanitize };
