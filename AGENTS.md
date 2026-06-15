# Wakefield

Wakefield is a local-first runtime for persistent Codex-thread agents. Keep it small, readable, and reusable.

- Do not bake application-specific business workflows into the Wakefield core.
- Add one reusable capability at a time, with focused tests.
- Store user runtime state in the operating system's normal app support location, not in Git.
- Treat Codex hooks as the memory boundary for manual turns.
- Keep hook handlers fast; enqueue heavier memory and dreaming work for background processes.
- Prefer truthful doctor/readiness output over optimistic status.
