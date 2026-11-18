# Usage diagnostic logs

Host-local JSONL for offline analysis; no UI, model messages, prices, or automatic delegation rules.
Each new SDK query connection writes a UUID-named file under the effective
`CLAUDE_CONFIG_DIR/logs/usage/` (default: `~/.aide/claude/logs/usage/`).
Resume/reconnect may create several files for the same session: collect all of them.
These files accompany, rather than replace, the CLI's original session/subagent transcripts.
Only sessions run after this change produce these diagnostics.

## Recorded observations

- `query_id`, `routing_id`, SDK `session_id`, and, for Aide child sessions, `parent_session_id`.
- `assistant_usage`: reported per-message usage, model, message ID, and `parent_tool_use_id`
  (absent for the main thread). Input/cache/output counters are kept only when supplied.
- `agent_dispatch`: delegation tool ID, enclosing delegation ID, agent type (including `fork`),
  requested model, resumed agent ID, and task prompt character count. No prompt text.
- `agent_result`: structured Agent/Task result, linked to the delegation tool ID and agent ID;
  reported usage breakdown and run totals when available. Async launch acknowledgements are
  `agent_run_reference`, not completed usage. Their output-file reference is retained.
- `task_started`, `task_progress`, `task_notification`: task/run/tool IDs, output-file references,
  status, and usage as reported. These can also describe non-agent background tasks: join to
  `agent_dispatch` before attributing them to an agent.
- `query_result`: SDK-reported aggregate usage/model usage/cost and turn count, explicitly labelled
  `sdk_aggregate_snapshot`. These are SDK estimates, not provider invoices.

No conversation text, tool arguments/results, credentials, images, or system prompts are copied.
Identifiers, model names and local output-file paths remain local; review before sharing logs.
Provider identity is not supplied to this observer; resolve it from session metadata when needed.

## Accounting rules and limits

These observations are **not additive ledger entries**. Do not sum all rows.

1. Assistant messages can repeat the same message ID with updated usage as blocks arrive.
   Group by session, parent tool ID and message ID; retain the latest reported counters.
   Missing IDs/counters mean unavailable data, not zero. Do not infer an exact request count
   from records lacking IDs. Usage is provider-reported and may include synthetic responses.
2. Agent run totals, task progress/final totals and SDK aggregates can overlap those messages.
   Use them as alternative totals/checks. Never add them together. Establish whether SDK
   aggregates are per-turn or cumulative from real samples before taking differences.
3. Background child request messages are not guaranteed to arrive through the parent SDK stream.
   The observer does not parse/tail extra transcripts. Use the retained output-file reference
   and original CLI subagent transcripts for missing request details. It does not invent a
   breakdown when only `total_tokens` is supplied. Incomplete/aborted runs may have no final total.
4. Input plus cache counters describe reported request usage, not the maximum context window or
   an exact tokenizer measurement. Delegation prompt characters are not tokens. Comparing main
   vs delegated execution requires comparable tasks, quality checks and provider cache pricing;
   a single run cannot establish the alternative run's cost.

Writes are asynchronous, ordered per file, and fail open with one stderr warning on IO failure.
The queue is capped at 256 records per connection; overflow warns and the next accepted row's
`dropped_before` reports the gap. A process crash/forced exit can lose queued records, and a final
overflow without a later accepted row is only visible through stderr. Logs have no automatic
retention/deletion; they contain metadata only, and can be removed after analysis.
