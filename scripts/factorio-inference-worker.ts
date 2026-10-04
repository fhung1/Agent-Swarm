import { inferenceWorkerMain, inferenceFailureExitCode } from '../src/factorio/inference-worker.ts';
inferenceWorkerMain().catch(error => { console.error(error); process.exitCode = inferenceFailureExitCode(error); });
