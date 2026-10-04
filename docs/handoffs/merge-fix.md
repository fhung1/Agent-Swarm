# Factorio journal and demo handoff

The operation-journal primitive landed in `8d73004` with durable intent/receipt, scope/digest and rollback checks, including a process race test. See [journal semantics](../factorio-operation-journal.md).

Historical rules-demo integration and viewing were separate work. Current main contains newer prompted workers and launcher; use [the current run guide](../factorio-inference.md). Preserve world state and active file owners when integrating recovery. A storage-unit test is not evidence of end-to-end live recovery.
