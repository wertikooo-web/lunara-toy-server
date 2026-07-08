# +++ Workflow

When Alexey sends `+++` on a separate line, execute the current task using this cycle:

1. Check what already exists.
2. Identify the real gap and risk.
3. Design the cheapest safe solution first.
4. Implement in small steps.
5. Self-check the solution.
6. Find holes, bugs, and side effects.
7. Fix the bugs.
8. Produce the improved version.
9. Commit/deploy through the available project path.
10. Report exactly what changed.
11. Explain how to test it.
12. Name the next practical step.

Rules:

- Do not jump to big infrastructure if a cheaper MVP path validates the same thing.
- Do not mix memory, content, conversation state, and audio cache.
- Do not claim Railway production is deployed unless the deployment is visible in logs.
- If the work only reached GitHub, say that clearly.
- If something was not tested on real hardware, Railway, or compiler/runtime, say so.
- Prefer one safe change at a time over broad rewrites.
