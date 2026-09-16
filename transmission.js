/* ============================================================
   ФИЗИКА ТРАНСМИССИИ — чистый модуль без DOM / Three.js
   ============================================================ */

export const GATE_X=[0.10,0.50,0.90];
export const ROW_Y=[0.17,0.50,0.83];

const ENGAGE_DIST=0.17;
const BAR_THRESH=0.10;

const GEAR_NODES=[
  {id:1,gx:0,row:0},{id:2,gx:0,row:2},{id:3,gx:1,row:0},
  {id:4,gx:1,row:2},{id:5,gx:2,row:0},{id:'R',gx:2,row:2},
];
const GEAR_RATIO={1:1,2:2,3:3,4:4,5:5,'R':-1,'N':1};

export const PHYS={
  SLOW:0.1,
  K:6, GS:30,
  ROLL_DECEL:1.2, AERO_K:1.5e-4, HOLD_DECEL:0.05,
  GOV:12, Ie:10, GEAR_LOAD:8,
  BRK_VISC:7.0, BRK_LOCK:2.6,
  FULL_DEPRESS:0.95, REJECT_DUR:1.0,
  IDLE_RPM:800, STALL_RPM:700, CRANK_RPM:320,
  BLOCK_MSG_DUR:2.0, FAIL_DUR:0.5,
  SPEED_K:0.008,
};

const RPM2O=Math.PI/30*PHYS.SLOW;
const IDLE_OMEGA=PHYS.IDLE_RPM*RPM2O;
const STALL_OMEGA=PHYS.STALL_RPM*RPM2O;
const CRANK_OMEGA=PHYS.CRANK_RPM*RPM2O;

function nodePos(g){
  if(String(g)==='N') return {x:GATE_X[1],y:ROW_Y[1]};
  const n=GEAR_NODES.find(n=>String(n.id)===String(g));
  return {x:GATE_X[n.gx], y:ROW_Y[n.row]};
}

let curGate=1;
function constrainToH(nx,ny){
  const onBarZone=Math.abs(ny-ROW_Y[1])<BAR_THRESH;
  if(onBarZone){
    let gi=0,bd=Infinity;
    for(let i=0;i<3;i++){ const d=Math.abs(nx-GATE_X[i]); if(d<bd){bd=d;gi=i;} }
    curGate=gi;
    return {x:Math.max(GATE_X[0],Math.min(GATE_X[2],nx)), y:ROW_Y[1]};
  }
  return {x:GATE_X[curGate], y:Math.max(ROW_Y[0],Math.min(ROW_Y[2],ny))};
}

function snapGear(nx,ny){
  if(Math.abs(ny-ROW_Y[1])<0.02) return 'N';
  let best='N',bd=Infinity;
  for(const n of GEAR_NODES){
    const px=GATE_X[n.gx],py=ROW_Y[n.row];
    const d=(nx-px)*(nx-px)+(ny-py)*(ny-py);
    if(d<bd){bd=d;best=n.id;}
  }
  return best;
}

function friction(pp){ if(pp<=0.4) return 1; if(pp>=0.6) return 0; return (0.6-pp)/0.2; }
function gapF(pp){ return Math.max(0,(pp-0.4)/0.6); }

export class Transmission{
  constructor(){
    this.reset();
    this.msg={html:'Нажмите «Старт», чтобы завести двигатель',cls:'info',kind:'info'};
  }
  reset(){
    this.p=0; this.gasP=0; this.brakeP=0; this.rpmTarget=800;
    this.brakeKey=0; this.brakeReturn=false; this.brakeDragging=false;
    this.gearSel='N';
    this.leverNX=GATE_X[1]; this.leverNY=ROW_Y[1];
    this.goalNX=GATE_X[1]; this.goalNY=ROW_Y[1];
    this.tryGear=null; this.pendingGear=null; this.rejectTimer=0;
    this.shifterTargetX=0.55; this.wasAtNeutral=true;
    this.noClutchShiftTimer=0;
    this.engineState='off'; this.crankT=0; this.failCrankT=0;
    this.thE=0; this.discAng=0; this.axleAng=0;
    this.engOmega=0; this.dOmega=0; this.aOmega=0;
    this.gElast=0; this.curGR=1; this.blocked=0; this.blockMsgTimer=0;
    this.brakeHeat=0;
    this.gateT=0.5; this.rowT=0.5;
    this.gE=0; this.e=1; this.gf=0; this.slip=0; this.slipN=0;
    this.speedN=0; this.clutchSlipping=false;
    this.sparkLevel=0; this.cdx=-1.00; this.gx=0;
    this.clash=0; this.clashActive=false; this.mismatchNow=0;
    this.brakeLevel=0;
  }

  setClutch(v){ this.p=v; }
  setGas(v){ this.gasP=v; this.rpmTarget=800+v*3200; }
  setBrake(v){ this.brakeP=v; this.brakeReturn=false; }
  releaseBrake(){ this.brakeReturn=true; }
  holdBrake(on){ this.brakeKey=on?1:0; this.brakeReturn=!on; }
  setBrakeDragging(d){ this.brakeDragging=d; }

  shiftBlocked(){ return this.engineState==='running' && this.p<PHYS.FULL_DEPRESS; }

  beginGearDrag(){ this.rejectTimer=0; this.pendingGear=null; }
  dragGear(nx,ny){
    const c=constrainToH(nx,ny);
    const intended=snapGear(c.x,c.y);
    if(this.shiftBlocked() && String(intended)!==String(this.gearSel)){
      const np=nodePos(this.gearSel);
      this.goalNX=np.x; this.goalNY=np.y;
      this.tryGear=intended;
      this.noClutchShiftTimer=1.0;
    } else {
      this.goalNX=c.x; this.goalNY=c.y;
      this.gearSel=intended;
      this.tryGear=null;
    }
  }
  releaseGear(){
    if(this.shiftBlocked()){
      const np=nodePos(this.gearSel);
      this.goalNX=np.x; this.goalNY=np.y;
      this.tryGear=null; this.pendingGear=null; this.rejectTimer=0;
      this.noClutchShiftTimer=0.5;
    } else {
      const g=snapGear(this.goalNX,this.goalNY);
      this.gearSel=g; this.tryGear=null; this.pendingGear=null; this.rejectTimer=0;
      const np=nodePos(g); this.goalNX=np.x; this.goalNY=np.y;
    }
  }
  keyGear(k){
    if(k==='N'){
      if(!this.shiftBlocked()){ this.gearSel='N'; this.goalNX=GATE_X[1]; this.goalNY=ROW_Y[1]; }
    } else if('12345R'.includes(k) && k.length===1){
      if(!this.shiftBlocked()){
        this.gearSel=(k==='R')?'R':Number(k);
        const np=nodePos(this.gearSel); this.goalNX=np.x; this.goalNY=np.y;
      }
    }
  }
  pressStart(){
    if(this.engineState==='running'){
      this.engineState='off'; this.rpmTarget=PHYS.IDLE_RPM; this.gasP=0;
      this.msg={html:'Двигатель заглушен.<small>Нажмите круглую кнопку СТАРТ, чтобы завести снова.</small>',cls:'info',kind:'kill'};
      return 'stop';
    }
    if(this.engineState==='cranking') return 'busy';
    const clutchOut=this.p<0.5;
    const gearOn=String(this.gearSel)!=='N';
    if(clutchOut && gearOn){
      this.msg={html:'⚠️ Для запуска выжмите сцепление или включите нейтраль<small>Стартер крутит, но двигатель не запускается — включена передача</small>',cls:'warn',kind:'startlock'};
      this.failCrankT=PHYS.FAIL_DUR;
      return 'lock';
    }
    this.msg=null;
    this.engineState='cranking'; this.crankT=0; this.failCrankT=0;
    return 'started';
  }

  step(dt){
    const st=Math.min(dt,.033);

    if(this.brakeKey>0){
      this.brakeReturn=false;
      if(this.brakeP<1 && !this.brakeDragging) this.brakeP=Math.min(1,this.brakeP+dt*3);
    } else if(this.brakeReturn && !this.brakeDragging){
      this.brakeP+=(0-this.brakeP)*Math.min(1,dt*12);
      if(this.brakeP<0.004){ this.brakeP=0; this.brakeReturn=false; }
    }

    const eOmegaTarget=this.rpmTarget*RPM2O;
    const e=friction(this.p);
    const gf=gapF(this.p);
    const clutchT=e*PHYS.K*(this.engOmega-this.dOmega);

    const blockShift=this.shiftBlocked();
    if(this.rejectTimer>0){
      this.rejectTimer-=dt;
      if(!blockShift){
        this.rejectTimer=0;
        if(this.pendingGear!=null){
          this.gearSel=this.pendingGear;
          const np=nodePos(this.gearSel); this.goalNX=np.x; this.goalNY=np.y;
        }
        this.pendingGear=null; this.tryGear=null;
      } else if(this.rejectTimer<=0){
        const np=nodePos(this.gearSel); this.goalNX=np.x; this.goalNY=np.y;
        this.pendingGear=null;
      }
    }

    this.leverNX+=(this.goalNX-this.leverNX)*Math.min(1,dt*14);
    this.leverNY+=(this.goalNY-this.leverNY)*Math.min(1,dt*14);

    let gE=0;
    if(String(this.gearSel)!=='N'){
      const np=nodePos(this.gearSel);
      const d=Math.hypot(this.leverNX-np.x, this.leverNY-np.y);
      let t=1-Math.min(1,d/ENGAGE_DIST);
      gE=t*t*(3-2*t);
    }
    this.curGR=GEAR_RATIO[this.gearSel]||1;

    const clashGear=this.tryGear!=null?this.tryGear:this.gearSel;
    const mismatchNow=Math.abs(this.dOmega*(GEAR_RATIO[clashGear]||1)-this.aOmega);
    const clashActive=blockShift && this.tryGear!=null && String(this.tryGear)!==String(this.gearSel)
                      && gE<0.9 && mismatchNow>0.4;
    if(clashActive) gE=0;
    this.gElast=gE;
    this.mismatchNow=mismatchNow;
    this.clashActive=clashActive;

    const govFactor=e>0.5?(1.0-this.brakeP*this.brakeP*0.9):1.0;

    if(this.engineState==='running'){
      const gearMult=1+this.gElast*PHYS.GEAR_LOAD;
      this.engOmega+=st*(PHYS.GOV*govFactor*(eOmegaTarget-this.engOmega)-clutchT*gearMult/PHYS.Ie);
      const isShiftingWithoutClutch=blockShift&&this.tryGear!=null;
      if(this.engOmega<STALL_OMEGA && this.gElast>0.2 && !isShiftingWithoutClutch && this.noClutchShiftTimer<=0){
        this.engineState='stalled'; this.rpmTarget=PHYS.IDLE_RPM; this.gasP=0;
        this.blockMsgTimer=0; this.blocked=0;
        this.msg=this.brakeP>0.25
          ?{html:'⚠️ Двигатель заглох — резкое торможение на включённой передаче!<small>Перед торможением выжмите сцепление или выключите передачу, затем нажмите кнопку СТАРТ</small>',cls:'warn',kind:'stall'}
          :{html:'⚠️ Сцепление отпущено слишком быстро — двигатель заглох!<small>Нажмите кнопку СТАРТ: выжмите сцепление или включите нейтраль, затем отпускайте плавно (зона 40–60%)</small>',cls:'warn',kind:'stall'};
      }
    } else if(this.engineState==='cranking'){
      this.crankT+=dt;
      this.engOmega+=(CRANK_OMEGA-this.engOmega)*Math.min(1,dt*5);
      if(this.crankT>1.25){ this.engineState='running'; this.engOmega=Math.max(this.engOmega,IDLE_OMEGA); }
    } else {
      if(this.failCrankT>0){
        this.failCrankT-=dt;
        this.engOmega=0.55+Math.abs(Math.sin(performance.now()*0.035))*0.75;
      } else {
        this.engOmega+=st*(-5*this.engOmega);
        if(this.engOmega<0.01) this.engOmega=0;
      }
    }
    this.engOmega=Math.max(0,this.engOmega);

    if(this.noClutchShiftTimer>0){
      this.noClutchShiftTimer-=dt;
      if(this.noClutchShiftTimer<=0){
        const np=nodePos(this.gearSel);
        this.goalNX=np.x; this.goalNY=np.y;
        this.tryGear=null; this.pendingGear=null;
      }
    }

    if(clashActive){
      if(!this.blocked){
        this.blocked=1;
        this.blockMsgTimer=PHYS.BLOCK_MSG_DUR;
        this.msg={html:'⚠️ Передача не включается — выжмите сцепление полностью!<small>Передачи переключаются только при полностью выжатом сцеплении</small>',cls:'warn',kind:'block'};
      }
    } else {
      this.blocked=0;
    }
    if(this.blockMsgTimer>0){
      this.blockMsgTimer-=dt;
      if(this.blockMsgTimer<=0){
        this.blockMsgTimer=0;
        if(this.msg && this.msg.kind==='block') this.msg=null;
      }
    }

    const brkVisc=PHYS.BRK_VISC*this.brakeP;
    const dCut=gE>0.5?0:Math.max(0,(1-e))*1.6;
    const NSUB=32, h=st/NSUB;
    const driveCouple=gE*PHYS.GS;
    for(let s=0;s<NSUB;s++){
      const err=this.dOmega*this.curGR-this.aOmega;
      const rotSign=this.aOmega>=0?1:-1;
      const roadLoad=PHYS.ROLL_DECEL*rotSign + PHYS.AERO_K*this.aOmega*this.aOmega*rotSign + brkVisc*this.aOmega;
      this.dOmega+=h*(clutchT - driveCouple*this.curGR*err - dCut*this.dOmega);
      this.aOmega+=h*(driveCouple*err - roadLoad);
    }
    const staticDec=st*(PHYS.HOLD_DECEL + PHYS.BRK_LOCK*this.brakeP);
    if(this.aOmega>staticDec) this.aOmega-=staticDec;
    else if(this.aOmega<-staticDec) this.aOmega+=staticDec;
    else this.aOmega=0;
    this.dOmega=Math.max(this.dOmega,0);

    if(e>0.98){
      if(String(this.gearSel)==='N'){
        this.dOmega=this.engOmega;
      } else {
        const avg=(this.engOmega+this.dOmega)/2;
        this.engOmega=avg; this.dOmega=avg;
      }
    }

    this.thE+=this.engOmega*dt;
    this.discAng+=this.dOmega*dt;
    this.axleAng+=this.aOmega*dt;

    this.gateT=(this.leverNX-GATE_X[0])/(GATE_X[2]-GATE_X[0]);
    this.rowT=(this.leverNY-ROW_Y[0])/(ROW_Y[2]-ROW_Y[0]);
    const isAtNeutral=Math.abs(this.leverNY-ROW_Y[1])<0.03;
    const isMovingToGear=Math.abs(this.leverNY-ROW_Y[1])>0.05;
    if(isMovingToGear && !isAtNeutral){
      this.shifterTargetX=0.30; this.wasAtNeutral=false;
    } else if(isAtNeutral && !this.wasAtNeutral){
      this.shifterTargetX=0.55; this.wasAtNeutral=true;
    }

    const absOmega=Math.abs(this.aOmega);
    const speedN=Math.min(1,absOmega/6);
    const brakeLevel=this.brakeP*speedN;
    this.speedN=speedN;
    this.brakeLevel=brakeLevel;
    this.brakeHeat+=st*(brakeLevel*3.4-this.brakeHeat*0.45);
    this.brakeHeat=Math.max(0,Math.min(1,this.brakeHeat));

    const slip=Math.abs(this.engOmega-this.dOmega);
    const slipN=Math.min(1,slip/14);
    const gearEngaged=gE>0.5;
    const clutchSlipping=(e>0.02&&e<0.98)&&gearEngaged;
    const sparkLevel=clutchSlipping?Math.min(1,4*e*(1-e))*slipN:0;
    const cdx=-1.00+gf*0.25;
    const gx=(-1.04+(cdx-0.045))*0.5;
    this.slip=slip; this.slipN=slipN; this.clutchSlipping=clutchSlipping;
    this.sparkLevel=sparkLevel; this.cdx=cdx; this.gx=gx;
    this.e=e; this.gf=gf; this.gE=gE;

    this.clash=clashActive?Math.min(1,mismatchNow*1.2):0;
  }
}
