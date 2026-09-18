/* ============================================================
   ФИЗИКА ТРАНСМИССИИ — чистый модуль без DOM / Three.js
   Все настройки автомобиля вынесены в carConfig.js
   ============================================================ */

import {
PHYS, GEAR_RATIO, TQ_CURVE, GATE_X, ROW_Y, PWR_REF_PS
} from './carConfig.js';

/* реэкспорт настроек: удобно импортировать всё из transmission.js */
export { PHYS, GEAR_RATIO, TQ_CURVE, GATE_X, ROW_Y, CAR_NAME, PWR_REF_PS } from './carConfig.js';

/* раскладка передач по воротам рычага */
const GEAR_NODES=[
  {id:1,gx:0,row:0},{id:2,gx:0,row:2},{id:3,gx:1,row:0},
  {id:4,gx:1,row:2},{id:5,gx:2,row:0},{id:'R',gx:2,row:2},
];

/* производные величины — пересчитываются после изменения настроек */
const RPM_C=60/(2*Math.PI);       // рад/с → об/мин
let IDLE_W=PHYS.IDLE_RPM*Math.PI/30;
let ART_REV_W=PHYS.ART_REV_MAX*Math.PI/30;
let OVERREV_W=PHYS.REV_LIM*Math.PI/30;
export function refreshDerived(){
  IDLE_W=PHYS.IDLE_RPM*Math.PI/30;
  ART_REV_W=PHYS.ART_REV_MAX*Math.PI/30;
  OVERREV_W=PHYS.REV_LIM*Math.PI/30;
}

function nodePos(g){
  if(String(g)==='N') return {x:GATE_X[1],y:ROW_Y[1]};
  const n=GEAR_NODES.find(n=>String(n.id)===String(g));
  return {x:GATE_X[n.gx], y:ROW_Y[n.row]};
}

let curGate=1;
function constrainToH(nx,ny){
  const onBarZone=Math.abs(ny-ROW_Y[1])<PHYS.BAR_THRESH;
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

function friction(pp){
  if(pp<=0.4) return 1;
  if(pp>=0.6) return 0;
  const u=(0.6-pp)/0.2;
  const t0=PHYS.CLUTCH_T0;
  if(u<t0) return PHYS.CLUTCH_E0*(u/t0);
  const e0=PHYS.CLUTCH_E0;
  return e0+(1-e0)*Math.pow((u-t0)/(1-t0),PHYS.CLUTCH_E);
}
function gapF(pp){ return Math.max(0,(pp-0.4)/0.6); }

/* Кривая момента задаётся в carConfig.js (TQ_CURVE) — это значения для
   базовой мощности PWR_REF_PS. Фактический момент масштабируется по текущей
   мощности: t × PHYS.PWR_PS / PWR_REF_PS. */
function engineTorqueNm(rpm){
  const a=TQ_CURVE;
  let t;
  if(rpm<=a[0][0]) t=a[0][1];
  else{
    for(let i=1;i<a.length;i++){
      if(rpm<=a[i][0]){
        const p=a[i-1], q=a[i];
        t=p[1]+(q[1]-p[1])*(rpm-p[0])/(q[0]-p[0]);
        break;
      }
    }
    if(t===undefined){ const last=a[a.length-1]; t=Math.max(0,last[1]-(rpm-last[0])*0.08); }
  }
  return t*(PHYS.PWR_PS/PWR_REF_PS);
}

/* Мощность, л.с., при заданных оборотах: T(Н·м) × rpm / 7021.46 */
export function enginePowerPS(rpm){
  return engineTorqueNm(rpm)*rpm/7021.46;
}

/* Момент сопротивления на колёсах: качение + аэродинамика + тормоза, Н·м.
   Сопротивление — чисто диссипативное: при нулевой скорости оно равно нулю
   (иначе покоящуюся машину «тянуло» бы катить назад/вперёд). */
function loadWheelNm(wa,br){
  const vw=wa*PHYS.RWHEEL;
  const sign=vw>0?1:(vw<0?-1:0);
  return ((PHYS.ROLL*PHYS.MASS*9.81)*sign
        + (PHYS.AERO*0.5*1.225)*vw*Math.abs(vw)
        + PHYS.BRAKE_F*br*sign)*PHYS.RWHEEL;
}

export class Transmission{
  constructor(){
    this.reset();
    this.msg={html:'Нажмите «Старт», чтобы завести двигатель',cls:'info',kind:'info'};
  }
  reset(){
    this.p=0; this.gasP=0; this.brakeP=0; this.rpmTarget=PHYS.IDLE_RPM;
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
    this.sparkLevel=0; this.cdx=-1.00; this.gx=0;    this.clash=0; this.clashActive=false; this.mismatchNow=0;
    this.brakeLevel=0;
    this.idleI=0;
    this.bumpArmed=false;
  }

  setClutch(v){ this.p=v; }
  setGas(v){ this.gasP=v; this.rpmTarget=PHYS.IDLE_RPM+v*(PHYS.ART_REV_MAX-PHYS.IDLE_RPM); }
  setBrake(v){ this.brakeP=v; this.brakeReturn=false; }
  releaseBrake(){ this.brakeReturn=true; }
  holdBrake(on){ this.brakeKey=on?1:0; this.brakeReturn=!on; }
  setBrakeDragging(d){ this.brakeDragging=d; }

  /* Предел отпускания сцепления — до какой позиции педали сейчас можно
     отпустить и удержать без глоха. Возвращает позицию p: 0 — можно
     отпустить полностью; ближе к 0.4–0.6 — держать у зоны схватывания.
     Прогноз: клон состояния удерживает кандидат p и проверяется на глох. */
  releaseLimit(dt=1/60,horizon=0.5){
    if(this.engineState!=='running') return null;
    if(String(this.gearSel)==='N') return 0;
    const clone=()=>Object.assign(Object.create(Object.getPrototypeOf(this)),this);
    const n=Math.max(1,Math.round(horizon/dt));
    const safe=p=>{
      const c=clone();
      for(let i=0;i<n;i++){
        c.setClutch(p); c.step(dt);
        if(c.engineState!=='running') return false;
      }
      return true;
    };
    if(safe(0)) return 0;
    let lo=0,hi=0.6;
    for(let i=0;i<7;i++){ const m=(lo+hi)/2; if(safe(m)) hi=m; else lo=m; }
    return hi;
  }

  /* Нагрузка на колёсах, приведённая к коленвалу. При пуске стартером
     включённая передача соединяет коленвал с машиной, которая сопротивляется
     сдвигу (как если бы её толкали с места): стартер на низких передачах
     способен тронуть машину — её сопротивление HOLD_TQ меньше момента на
     колонне, но всё равно не даёт раскрутить коленвал до пусковых оборотов.
     Если нажат тормоз, машину держат колодки: суммарное сопротивление
     превышает момент стартера, машина стоит и коленвал не проворачивается.
     Знак повторяет loadWheelNm: на заднем ходу машина сопротивляется качению
     назад, и через отрицательное передаточное число это даёт тормозящий
     момент на коленвале. */
  crankLoad(wa,ratio){
    if(this.engineState==='cranking' && ratio){
      const sign=wa>=0?1:-1;
      const brake=PHYS.BRAKE_F*this.brakeP*PHYS.RWHEEL;
      return (PHYS.HOLD_TQ+brake)*sign;
    }
    return loadWheelNm(wa,this.brakeP);
  }

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
    this.msg=null;
    this.engineState='cranking'; this.crankT=0; this.failCrankT=0; this.idleI=0; this.bumpArmed=false;
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

    const e=friction(this.p);
    const gf=gapF(this.p);

    /* внутренние «визуальные» скорости → реальные рад/с */
    const k=PHYS.SLOW;
    let we=this.engOmega/k;   // коленвал
    let wd=this.dOmega/k;     // вход КПП (диск сцепления)
    let wa=this.aOmega/k;     // сторона колёс

    const inGear=String(this.gearSel)!=='N';
    const ratio=inGear?GEAR_RATIO[this.gearSel]*PHYS.FINAL_DRIVE:0;
    const Rw=PHYS.RWHEEL;
    const IwEff=PHYS.IW+PHYS.MASS*PHYS.INERTIA_K*Rw*Rw;

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
      let t=1-Math.min(1,d/PHYS.ENGAGE_DIST);
      gE=t*t*(3-2*t);
    }
    this.curGR=inGear?GEAR_RATIO[this.gearSel]*PHYS.FINAL_DRIVE:1;

    const clashGear=this.tryGear!=null?this.tryGear:this.gearSel;
    const mismatchNow=Math.abs(this.dOmega*((GEAR_RATIO[clashGear]||1)*PHYS.FINAL_DRIVE)-this.aOmega);
    const clashActive=blockShift && this.tryGear!=null && String(this.tryGear)!==String(this.gearSel)
                      && gE<0.9 && mismatchNow>0.4;
    if(clashActive) gE=0;
    this.gElast=gE;
    this.mismatchNow=mismatchNow;
    this.clashActive=clashActive;

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

    const shiftNoClutch=blockShift && this.tryGear!=null;
    if(this.engineState==='running' && we*RPM_C<PHYS.STALL_RPM && gE>0.2 && this.noClutchShiftTimer<=0 && !shiftNoClutch){
      this.engineState='stalled'; this.rpmTarget=PHYS.IDLE_RPM; this.gasP=0;
      this.blockMsgTimer=0; this.blocked=0; this.idleI=0; we=0;
      this.msg=this.brakeP>0.25
        ?{html:'⚠️ Двигатель заглох — резкое торможение на включённой передаче!<small>Перед торможением выжмите сцепление или выключите передачу, затем нажмите кнопку СТАРТ</small>',cls:'warn',kind:'stall'}
        :{html:'⚠️ Сцепление отпущено слишком быстро — двигатель заглох!<small>Нажмите кнопку СТАРТ: выжмите сцепление или включите нейтраль, затем отпускайте плавно (зона 40–60%)</small>',cls:'warn',kind:'stall'};
    }

    if(ratio){
      /* диск и колёса жёстко связаны передачей (скольжение — только на сцеплении) */
      wd=ratio*wa;
    }

    /* ------------------- ДВИГАТЕЛЬ + СЦЕПЛЕНИЕ -------------------
       Модель «замок/проскальзывание»: если сцепление способно
       удержать момент, коленвал и диск крутятся как одно целое,
       иначе — проскальзывание с моментом = ёмкость сцепления. */
    let Te=0, Td=0, capE=0, Tc=0, locked=false;

    if(this.engineState==='running'){
      const rpm=we*RPM_C;
      /* педаль газа — задатчик оборотов: 0% → холостые, 100% → 4000.
         ПИ-регулятор плавно выводит и держит заданные обороты. */
      const tgtW=IDLE_W+this.gasP*(ART_REV_W-IDLE_W);
      const err=tgtW-we;
      const TeMax=engineTorqueNm(rpm);
      const govPre=err*PHYS.GOV_KP+this.idleI;
      if(!((govPre>TeMax&&err>0)||(govPre<0&&err<0)))
        this.idleI=Math.max(0,Math.min(TeMax,this.idleI+err*dt*PHYS.GOV_KI));
      let gov=err*PHYS.GOV_KP+this.idleI;
      if(gov>TeMax) gov=TeMax;
      if(gov<0) gov=0;
      Te=gov;
      Td=PHYS.ENG_DRAG_B+PHYS.ENG_DRAG_K*rpm;
      /* отпущен газ (дроссель закрыт) — добавляем насосные потери:
         двигатель быстро сбрасывает обороты */
      if(gov<=0.01) Td+=PHYS.CLOSE_DRAG_B+PHYS.CLOSE_DRAG_K*rpm;
    } else if(this.engineState==='cranking'){
      /* стартер — машина постоянного тока с ограниченным моментом:
         максимален на нулевых оборотах и падает до 0 на холостом ходу.
         Если передача включена и сцепление не выжато, через колонну
         коленвал тащит машину: на низких передачах стартер её толкает,
         но из-за сопротивления сдвигу (HOLD_TQ) не может раскрутить
         коленвал до пусковой скорости — запуск срывается. */
      const rpm=we*RPM_C;
      Te=Math.max(0,PHYS.START_TQ*(1-rpm/PHYS.START_FREE_RPM));
      Td=PHYS.ENG_DRAG_B+PHYS.ENG_DRAG_K*rpm
        +PHYS.CLOSE_DRAG_B+PHYS.CLOSE_DRAG_K*rpm;
    } else {
      /* двигатель не работает: горения нет, только трение и компрессия.
         Колёса через сцепление при этом могут раскрутить коленвал. */
      const rpm=we*RPM_C;
      Td=PHYS.ENG_DRAG_B+PHYS.ENG_DRAG_K*rpm
        +PHYS.CLOSE_DRAG_B+PHYS.CLOSE_DRAG_K*rpm;
    }

    /* сцепление работает всегда, включая момент работы стартера:
       включённая передача соединяет коленвал с колонной */
    {
      capE=PHYS.CLUTCH_CAP*e;

      const refS=ratio?this.crankLoad(wa,ratio)/ratio:0;
      const I2=ratio?(PHYS.ID+IwEff/(ratio*ratio)):PHYS.ID;
      const Iall=PHYS.IE+I2;
      const wAcc=(Te-Td-refS)/Iall;
      const needT=Te-Td-PHYS.IE*wAcc;          // момент сцепления для сохранения захвата

      if(Math.abs(we-wd)<PHYS.SYNC_GAP && Math.abs(needT)<=capE){
        /* сцепление держит: коленвал и диск — одно целое */
        locked=true;
        const w0=(we+wd)/2;
        we=w0; wd=w0;
        we+=st*wAcc; wd+=st*wAcc;
        if(ratio) wa=wd/ratio;
      } else {
        /* проскальзывание: передаём ёмкость сцепления в сторону раскрутки */
        Tc=we>wd?capE:(we<wd?-capE:0);
        we+=st*(Te-Td-Tc)/PHYS.IE;
      }
    }

    if(this.engineState==='cranking'){
      this.crankT+=dt;
      if(we*RPM_C >= PHYS.CRANK_RPM){
        /* коленвал достиг пусковой скорости — двигатель схватил */
        this.engineState='running';
        this.idleI=0;
        if(we<IDLE_W) we=IDLE_W;
        this.msg=null;
      } else if(this.crankT>PHYS.START_DUR){
        /* стартер отработал, а раскрутить не смог — запуск сорван */
        this.engineState='off';
        this.msg={html:'Стартер толкает машину, но раскрутить двигатель не смог<small>Включена передача — выжмите сцепление и заводите двигатель</small>',cls:'warn',kind:'startfail'};
      }
    }

    if(!locked){
      if(ratio){
        const refS=this.crankLoad(wa,ratio)/ratio;
        const wdAcc=(Tc-refS)/(PHYS.ID+IwEff/(ratio*ratio));
        wd+=st*wdAcc;
        wa=wd/ratio;
      } else {
        wd+=st*(Tc-PHYS.DISC_DRAG*wd)/PHYS.ID;
        wa+=st*(-loadWheelNm(wa,this.brakeP))/IwEff;
      }
    }
    we=Math.max(0,we);
    if(we>OVERREV_W) we=OVERREV_W;
    /* выключенный двигатель не должен прокручивать вал и колёса «назад» из
       покоя: трение двигателя уводило сцепленную систему в минус, когда
       включена передача, — колонна медленно раскручивалась. Исключение —
       реальное качение назад (стартер толкнул машину на заднем ходу): его
       не срезаем, машина сама докатится до остановки. */
    if(this.engineState!=='running'){
      const revRoll=ratio<0 && wa<-0.05;
      if(!revRoll && wd<0) wd=0;
      if(ratio && !revRoll && wa<0) wa=0;
    }

    /* запуск «с толкача»: если заглохший двигатель раскрутили колёсами
       через сцепление (перед этим сцепление выжимали) — он схватывает */
    if(this.engineState==='stalled' && e<0.5) this.bumpArmed=true;
    if(this.engineState==='stalled' && this.bumpArmed && e>0.6 && we*RPM_C>=PHYS.BUMP_RPM){
      this.engineState='running'; this.bumpArmed=false; this.idleI=0;
      this.msg={html:'✅ Двигатель завёлся с толкача<small>Колёса раскрутили его через сцепление</small>',cls:'info',kind:'bump'};
    }

    this.engOmega=we*k; this.dOmega=wd*k; this.aOmega=wa*k;

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
