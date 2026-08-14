# @hitly/plugin-hermes

Hermes Agent adapter: ingest a command-approval or kanban block/review payload. Resume is a no-op — the Hermes plugin polls Hitly and applies the decision locally (command transport `present()`, or `hermes kanban comment` + `unblock`).
