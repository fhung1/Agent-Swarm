import { readFileSync, openSync, closeSync, fsyncSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export interface WorkerScope { runId: string; worldId: string; historyId: string; actorId: number }
export interface WorkerCheckpoint { version: 1; scope: WorkerScope; phase: 'production' | 'viewing'; nextView: number; tick: number }
export class WorkerCheckpoints {
  readonly path: string;
  readonly scope: WorkerScope;
  constructor(path: string, scope: WorkerScope) { this.path=path; this.scope=Object.freeze({...scope}); }
  load(): WorkerCheckpoint | undefined {
    let value: WorkerCheckpoint;
    try { value=JSON.parse(readFileSync(this.path,'utf8')); }
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
    if(value.version!==1 || !value.scope || value.scope.runId!==this.scope.runId || value.scope.worldId!==this.scope.worldId ||
      value.scope.historyId!==this.scope.historyId || value.scope.actorId!==this.scope.actorId ||
      !['production','viewing'].includes(value.phase) || !Number.isSafeInteger(value.nextView) || value.nextView<0 ||
      !Number.isSafeInteger(value.tick) || value.tick<0)throw Error('Foreign or corrupt worker checkpoint');
    return value;
  }
  save(phase: WorkerCheckpoint['phase'], nextView: number, tick: number): void {
    if(!Number.isSafeInteger(nextView)||nextView<0||!Number.isSafeInteger(tick)||tick<0)throw Error('Invalid worker checkpoint');
    const previous=this.load();
    if(previous && (tick<previous.tick || nextView<previous.nextView || (previous.phase==='viewing'&&phase==='production')))throw Error('Worker checkpoint rollback');
    mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
    const temporary=`${this.path}.tmp`, fd=openSync(temporary,'w',0o600);
    try{writeFileSync(fd,JSON.stringify({version:1,scope:this.scope,phase,nextView,tick}));fsyncSync(fd)}finally{closeSync(fd)}
    renameSync(temporary,this.path);
    const dir=openSync(dirname(this.path),'r');try{fsyncSync(dir)}finally{closeSync(dir)}
  }
  /** A board completion is authoritative only with its matching avatar evidence.
   * Missing receipt evidence is never replaced by a fresh transfer request.
   */
  recoveryPhase(input: { tick: number; boardReady: boolean; taskStatus: string; taskOwner: string; worker: string; ironPlates: number; productionReceiptsVerified: boolean }): 'production' | 'viewing' {
    if(!input.boardReady)throw Error('Board outage');
    const previous=this.load();
    if(previous && input.tick<previous.tick)throw Error('World tick rollback');
    if(input.taskOwner!==input.worker || !['claimed','done'].includes(input.taskStatus))throw Error('Task ownership lost');
    const completed=input.taskStatus==='done'||previous?.phase==='viewing';
    if(completed){
      if(input.ironPlates!==5 || !input.productionReceiptsVerified)throw Error('Unknown production outcome; quarantine');
      return 'viewing';
    }
    return 'production';
  }
}
