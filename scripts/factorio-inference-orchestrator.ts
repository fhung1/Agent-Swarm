import { factorioOrchestratorMain } from '../src/factorio/orchestrator.ts';
import { isTransientTransportFailure, RETRYABLE_TRANSPORT_FAILURE } from '../src/factorio/transient-errors.ts';
factorioOrchestratorMain().catch(error => { console.error(error); process.exitCode = isTransientTransportFailure(error) ? RETRYABLE_TRANSPORT_FAILURE : 1; });
