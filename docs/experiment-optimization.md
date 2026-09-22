# Experiment optimization — phases 1–3

## Baseline and preservation

AI paused through Socket.IO `control: {type: pause_ai}` with `control_ack.ok=true` before inspection. Minecraft/world and both containers left running; no redeploy, world reset or credential changes. Pre-existing work retained.

Cached pre-pause status (not a fresh paused observation): elapsed 342802 ms, strategic calls 8, reported tokens 33398, deaths 0; HP20, hunger16, position (-39.5,51,0.7). This is an observational baseline, not a controlled comparison. Baseline 66/66 offline tests passed. Raw local evidence and pre-change tracked patch: `/tmp/mineblind-optimization/` (temporary, not committed).

## Changes

- Navigation: one 50 ms A* slice with 100 ms total budget and radius32; reject partial/no-path before goto, 12-second movement deadline and existing 8-second stall check. Conservative: reachable but costly paths may be rejected.
- Collection: scan at most eight candidates, attempt at most three; remember failed concrete blocks independent of bot movement, invalidate on nearby terrain/inventory changes or expiry. Select a harvest-eligible tool rather than trusting fastest tool alone. Continue after bounded pickup path failures; inventory delta remains the success criterion.
- Exploration: idle mining/crafting/waiting no longer counts as stuck movement.
- Planning: local path/pickup failures do not cancel in-flight paid planning and escalate after three failures; prerequisites escalate directly. Lifecycle invalidation still cancels stale results.
- Suppress successful repeated planning for unchanged semantic goal/evidence for `UNCHANGED_PLAN_MS` (default300000). Ignore goal IDs, clocks and sub-block jitter. Record both pre/post-plan signatures; clear on lifecycle changes. This is a cooldown, not a hard spend cap.
- Independent strategic/tactical provider circuits: exponential retry for timeouts/rate limits; authentication/billing failures require intervention (new runtime after credentials fixed). Selector falls back locally. Circuit status included in experiment payload.

## Validation

`npm test`: 73/73 pass. `git diff --check`: pass. Active LSP probes reported no diagnostics but could not confirm clean (push-only server); not counted as validation proof.

New offline regressions cover provider circuits, planning evidence, concrete block memory, bounded path probe, alternate-block/tool recovery, local failure escalation and repeated planning suppression. Existing latency/lifecycle tests updated for intentional cancellation/backoff semantics.

## Remaining / live validation gate

Changes are source-only, not deployed. No new paid validation performed. Ask for a duration and paid-call/token ceiling before rebuilding/restarting bot (which auto-starts AI). Suggested controlled run: same world, maximum 3 minutes / 2 strategic calls / 10000 reported strategic tokens; stop on first ceiling. Token reporting and polling cannot guarantee a hard monetary cap or prevent an in-flight overshoot. Use provider spend limits for a hard currency cap.

Pickup timing/drop physics, real cave path feasibility and improvement in resources-per-token remain unverified live. Concrete-block memory is process-local. Exploration candidate ranking and full acquisition benchmark/HUD phase remain later work.
