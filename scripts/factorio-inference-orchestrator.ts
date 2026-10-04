import { factorioOrchestratorMain } from '../src/factorio/orchestrator.ts';
factorioOrchestratorMain().catch(error => { console.error(error); process.exitCode = 1; });
