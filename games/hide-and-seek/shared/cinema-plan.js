(function attachCinemaPlan(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CinemaPlan = api;
})(typeof window !== 'undefined' ? window : globalThis, function createCinemaPlanApi(root) {
  'use strict';

  const geometry = root?.HotelCollision || (typeof require === 'function' ? require('./collision-logic.js') : null);
  if (!geometry) throw new Error('Crowne Point Cinema requires HotelCollision.');
  const { boxBounds } = geometry;

  const HALF_TURN = Math.PI / 2;
  const FLOOR_DEFS = Object.freeze([
    Object.freeze({ id: 1, name: 'Lobby & Auditoriums' }),
    Object.freeze({ id: 2, name: 'Projection Mezzanine' }),
  ]);
  const SHELL = Object.freeze({ minX: -62, maxX: 62, minZ: -52, maxZ: 50 });
  const AUD_H = 7.8;
  const WALL_H = 3.2;

  const AUDITORIUMS = Object.freeze([
    Object.freeze({ id:'301', name:'THEATER 1', floor:1, side:'west', tier:'large',  minX:-56,maxX:-16,minZ:25,maxZ:45 }),
    Object.freeze({ id:'302', name:'THEATER 2', floor:1, side:'west', tier:'medium', minX:-56,maxX:-16,minZ:3,maxZ:21 }),
    Object.freeze({ id:'303', name:'THEATER 3', floor:1, side:'west', tier:'small',  minX:-56,maxX:-16,minZ:-18,maxZ:-1 }),
    Object.freeze({ id:'304', name:'THEATER 4', floor:1, side:'east', tier:'large',  minX:16,maxX:56,minZ:25,maxZ:45 }),
    Object.freeze({ id:'305', name:'THEATER 5', floor:1, side:'east', tier:'medium', minX:16,maxX:56,minZ:3,maxZ:21 }),
    Object.freeze({ id:'306', name:'THEATER 6', floor:1, side:'east', tier:'small',  minX:16,maxX:56,minZ:-18,maxZ:-1 }),
  ].map((room) => Object.freeze({
    ...room,
    entryZ: room.minZ + 2.7,
    serviceExitZ: room.minZ + 1.4,
    seatMinZ: room.minZ + 7.0,
    seatMaxZ: room.maxZ - 1.0,
  })));

  const BOOTHS = Object.freeze(AUDITORIUMS.map((aud, index) => {
    const centerZ = (aud.seatMinZ + aud.seatMaxZ) / 2;
    return Object.freeze({
      id: String(401 + index),
      name: `PROJECTION ${index + 1}`,
      floor: 2,
      side: aud.side,
      auditorium: aud.id,
      minX: aud.side === 'west' ? -28 : 10,
      maxX: aud.side === 'west' ? -10 : 28,
      minZ: centerZ - 3.5,
      maxZ: centerZ + 3.5,
      entryZ: centerZ,
    });
  }));

  const STAIRS = Object.freeze([
    Object.freeze({ id:'west-projection-stair', x:-14, minX:-16, maxX:-12, startZ:-40, endZ:-18, width:2.6 }),
    Object.freeze({ id:'east-projection-stair', x:14, minX:12, maxX:16, startZ:-40, endZ:-18, width:2.6 }),
  ]);

  // The game-owned lobby lift complements the reference's two physical projection stairs.
  const LIFT = Object.freeze({ centerX:42, centerZ:-36, frontZ:-37.6, halfWidth:1.5, halfDepth:1.6 });
  const clean = (v) => (Math.abs(v) < 1e-12 ? 0 : Number(Number(v).toFixed(9)));

  function createCinemaPlan({ config, floorDefs = FLOOR_DEFS, layout, floorY, keyIdForFloor, keyLabelForFloor }) {
    const FLOOR_H = config.floorHeight;
    const SHELL_H = FLOOR_H * floorDefs.length;
    const boxes=[], surfaces=[], swingDoors=[], slidingDoors=[], roomDoors=[], secretPanels=[], secretTunnels=[],
      roomCenters=[], furnishings=[], hallDoors=[], signs=[], doorFrames=[], wallLamps=[], lights=[], fixtures=[];
    const stairs={ treads:[], rails:[] };
    const levelY=(floor)=>(floor-1)*FLOOR_H;

    function box({floor,group='floor',kind,material='wall',collider=true,x,localY,z,w,h,d,rotationY=0,id=null,callFloor=null}) {
      boxes.push({floor,group,kind,material,collider,id,callFloor,x:clean(x),y:clean(levelY(floor)+localY),z:clean(z),w:clean(w),h:clean(h),d:clean(d),rotationY,localY:clean(localY)});
    }
    function prop({floor,x,z,w,h,d,localY=h/2,material='dark',collider=false,rotationY=0,id=null}) {
      box({floor,kind:'prop',material,collider,x,localY,z,w,h,d,rotationY,id});
    }
    function wallX({floor,x,z,width,base=0,height=WALL_H,material='wall'}) {
      if(width>.02) box({floor,kind:'wall',material,x,localY:base+height/2,z,w:width,h:height,d:.22});
    }
    function wallZ({floor,x,z,depth,base=0,height=WALL_H,material='wall'}) {
      if(depth>.02) box({floor,kind:'wall',material,x,localY:base+height/2,z,w:.22,h:height,d:depth});
    }
    function splitWall({floor,axis,fixed,from,to,openings=[],base=0,height=WALL_H,material='wall'}) {
      const sorted=openings.slice().sort((a,b)=>a.center-b.center); let cursor=from;
      for(const opening of sorted){
        const low=opening.center-opening.width/2, high=opening.center+opening.width/2;
        if(low>cursor+.02){
          const c=(cursor+low)/2,l=low-cursor;
          axis==='x'?wallX({floor,x:c,z:fixed,width:l,base,height,material}):wallZ({floor,x:fixed,z:c,depth:l,base,height,material});
        }
        const clearance=opening.height||2.35, hh=Math.max(.15,height-clearance), hy=base+clearance+hh/2;
        axis==='x'
          ? box({floor,kind:'wall',material,x:opening.center,localY:hy,z:fixed,w:opening.width,h:hh,d:.22})
          : box({floor,kind:'wall',material,x:fixed,localY:hy,z:opening.center,w:.22,h:hh,d:opening.width});
        cursor=high;
      }
      if(cursor<to-.02){
        const c=(cursor+to)/2,l=to-cursor;
        axis==='x'?wallX({floor,x:c,z:fixed,width:l,base,height,material}):wallZ({floor,x:fixed,z:c,depth:l,base,height,material});
      }
    }
    function slabRect({floor,minX,maxX,minZ,maxZ,material='carpetRed',topY=0,priority=0}) {
      if(maxX-minX<=.02||maxZ-minZ<=.02)return;
      box({floor,kind:'slab',material,collider:false,x:(minX+maxX)/2,localY:topY-.1,z:(minZ+maxZ)/2,w:maxX-minX,h:.2,d:maxZ-minZ});
      surfaces.push({kind:'rect',floor,priority,minX:clean(minX),maxX:clean(maxX),minZ:clean(minZ),maxZ:clean(maxZ),y:clean(levelY(floor)+topY)});
    }
    function ceilingRect({floor,minX,maxX,minZ,maxZ,height=WALL_H,material='ceiling'}) {
      if(maxX-minX<=.02||maxZ-minZ<=.02)return;
      box({floor,kind:'ceiling',material,collider:false,x:(minX+maxX)/2,localY:height,z:(minZ+maxZ)/2,w:maxX-minX,h:.12,d:maxZ-minZ});
    }
    function tiledArea({floor,minX,maxX,minZ,maxZ,material,exclude=[],ceiling=false,ceilingHeight=WALL_H}) {
      const xs=[minX,maxX], zs=[minZ,maxZ];
      for(const r of exclude){
        if(r.maxX<=minX||r.minX>=maxX||r.maxZ<=minZ||r.minZ>=maxZ) continue;
        xs.push(Math.max(minX,r.minX),Math.min(maxX,r.maxX));
        zs.push(Math.max(minZ,r.minZ),Math.min(maxZ,r.maxZ));
      }
      xs.sort((a,b)=>a-b); zs.sort((a,b)=>a-b);
      const ux=[...new Set(xs)], uz=[...new Set(zs)];
      for(let xi=0;xi<ux.length-1;xi++) for(let zi=0;zi<uz.length-1;zi++){
        const a=ux[xi],b=ux[xi+1],c=uz[zi],d=uz[zi+1];
        if(b-a<=.02||d-c<=.02) continue;
        const cx=(a+b)/2,cz=(c+d)/2;
        if(exclude.some(r=>cx>r.minX&&cx<r.maxX&&cz>r.minZ&&cz<r.maxZ)) continue;
        ceiling ? ceilingRect({floor,minX:a,maxX:b,minZ:c,maxZ:d,height:ceilingHeight}) : slabRect({floor,minX:a,maxX:b,minZ:c,maxZ:d,material});
      }
    }
    function pointLight({floor,x,z,localY=2.55,color=0x8a1010,intensity=.45,distance=9}) {
      lights.push({floor,kind:'point',color,intensity,distance,decay:2,x:clean(x),y:clean(levelY(floor)+localY),z:clean(z),localY:clean(localY)});
    }
    function doorFrame({floor,axis,fixed,center,width,height=2.35,material='brass'}) {
      const alongZ=axis==='z';
      doorFrames.push({floor,axis,x:clean(alongZ?fixed-.07:center),z:clean(alongZ?center:fixed-.07),width:clean(width),height,material,localY:0,y:clean(levelY(floor))});
    }
    function hingedLeaf({id,floor,fixed,center,width,openAngle,extra={}}) {
      return {id,kind:'room',floor,side:openAngle<0?'left':'right',direction:openAngle<0?-1:1,
        x:clean(fixed),z:clean(center),width:clean(width),hingeX:clean(fixed),hingeZ:clean(center-width/2),
        y:clean(levelY(floor)+1.06),localX:0,localZ:clean(width/2),w:.1,h:2.12,d:clean(width),openAngle,...extra};
    }
    function place(type,floor,x,z,rotationY=0,extra={}) {
      const id=`cinema-${floor}-${furnishings.length+1}`;
      furnishings.push({id,type,floor,x:clean(x),z:clean(z),rotationY,y:clean(levelY(floor)),color:0x52202a,...extra});
      // Use the same silhouettes as the renderer and authoritative collision on every map.
      for(const [index,body] of geometry.furnishingColliders(furnishings.at(-1)).entries()) {
        const offset=geometry.rotateY(body.x||0,body.z||0,rotationY);
        box({floor,group:'furnishing',kind:'furnishing',x:x+offset.x,z:z+offset.z,localY:body.y,
          w:body.w,h:body.h,d:body.d,rotationY,id:`${id}-collider-${index}`});
      }
      return id;
    }
    function addSign({floor,text,x,z,rotationY,w=4,h=.62,localY=2.8}) {
      signs.push({floor,text,x:clean(x),y:clean(levelY(floor)+localY),localY,z:clean(z),rotationY,w,h});
    }

    const audExcludes=AUDITORIUMS.map(a=>({minX:a.minX,maxX:a.maxX,minZ:a.minZ,maxZ:a.maxZ}));
    const stairCeilingExcludes=STAIRS.map(s=>({minX:s.minX-.25,maxX:s.maxX+.25,minZ:s.startZ-1.2,maxZ:s.endZ+.2}));
    const liftVoid={minX:40.5,maxX:43.5,minZ:-37.75,maxZ:-34.4};

    // V3 rule: Floor 1 is one continuous slab. Auditorium tiers are raised above it, never used as
    // substitutes for the base floor. This removes the missing-floor holes from V2 entirely.
    slabRect({floor:1,minX:SHELL.minX,maxX:SHELL.maxX,minZ:SHELL.minZ,maxZ:SHELL.maxZ,material:'carpetRed'});

    // Public ceiling only. Double-height auditoriums and both stair flights are explicit voids in the
    // ceiling, but NOT in the floor.
    tiledArea({
      floor:1,minX:SHELL.minX,maxX:SHELL.maxX,minZ:SHELL.minZ,maxZ:SHELL.maxZ,
      material:'ceiling',exclude:[...audExcludes,...stairCeilingExcludes,liftVoid],ceiling:true,ceilingHeight:3.2
    });

    // Closed glass entrance prevents a player stepping outside the authored floor.
    splitWall({floor:1,axis:'x',fixed:SHELL.minZ,from:SHELL.minX,to:SHELL.maxX,openings:[{center:0,width:7,height:3.1}],base:0,height:SHELL_H,material:'dark'});
    box({floor:1,kind:'wall',material:'glass',x:0,z:SHELL.minZ,localY:1.55,w:7,h:3.1,d:.12});
    wallX({floor:1,x:0,z:SHELL.maxZ,width:SHELL.maxX-SHELL.minX,base:0,height:SHELL_H,material:'dark'});
    wallZ({floor:1,x:SHELL.minX,z:0,depth:SHELL.maxZ-SHELL.minZ,base:0,height:SHELL_H,material:'dark'});
    wallZ({floor:1,x:SHELL.maxX,z:0,depth:SHELL.maxZ-SHELL.minZ,base:0,height:SHELL_H,material:'dark'});
    doorFrame({floor:1,axis:'x',fixed:SHELL.minZ,center:0,width:7,height:3.1,material:'brass'});
    addSign({floor:1,text:'CROWNE POINT CINEMA',x:0,z:-45.6,rotationY:0,w:10.5,h:.9,localY:2.85});

    // Lobby / box office / concession identity.
    addSign({floor:1,text:'LAST SHOWING  11:45',x:0,z:-45.6,rotationY:0,w:5.5,h:.48,localY:2.1});
    place('desk',1,-8,-48,0,{label:'ticket counter'}); place('desk',1,8,-48,0,{label:'ticket counter'});
    place('couch',1,-23,-39,0); place('couch',1,23,-39,Math.PI);
    place('plant',1,-28,-44,0); place('plant',1,28,-44,0);
    // Two concession wings leave a central lane into the public hall.
    prop({floor:1,x:-5,z:-31.8,w:8,h:1.1,d:1.15,localY:.55,material:'wood',collider:true,id:'concession-west'});
    prop({floor:1,x:5,z:-31.8,w:8,h:1.1,d:1.15,localY:.55,material:'wood',collider:true,id:'concession-east'});
    for(const x of [-8,-4,4,8]) prop({floor:1,x,z:-31.1,w:2.2,h:.55,d:.12,localY:2.15,material:'screen',collider:false});
    addSign({floor:1,text:'CONCESSIONS',x:0,z:-33.0,rotationY:Math.PI,w:4.8,h:.42,localY:2.86});
    prop({floor:1,x:0,z:-31.8,w:19,h:.16,d:2,localY:2.55,material:'wood',collider:false});
    for(const [x,text] of [[-8,'POPCORN'],[-4,'COLD DRINKS'],[4,'COMBOS'],[8,'CANDY']]) {
      addSign({floor:1,text,x,z:-31.18,rotationY:Math.PI,w:2.1,h:.45,localY:2.15});
      pointLight({floor:1,x,z:-33.5,localY:2.6,color:0xe6b778,intensity:2.1,distance:13});
    }
    for(const x of [-22,22]) pointLight({floor:1,x,z:-41,localY:2.6,color:0xbb804c,intensity:1.7,distance:14});
    // Popcorn/display cases.
    for(const x of [-8,-4,4,8]){
      prop({floor:1,x,z:-31.0,w:1.6,h:1.0,d:.72,localY:1.5,material:'glass',collider:false});
      prop({floor:1,x,z:-31.0,w:1.72,h:.12,d:.8,localY:2.02,material:'metal',collider:false});
    }
    // Arcade pockets and restroom wayfinding.
    for(const [x,z,r] of [[-30,-29,HALF_TURN],[-30,-26,HALF_TURN],[-30,-23,HALF_TURN],[-26,-29,HALF_TURN]]) place('vending',1,x,z,r,{label:'arcade cabinet'});
    addSign({floor:1,text:'ARCADE',x:-24.2,z:-27,rotationY:HALF_TURN,w:3.1,h:.6});
    addSign({floor:1,text:'RESTROOMS',x:24.2,z:-27,rotationY:-HALF_TURN,w:4.2,h:.6});
    // Poster lightboxes down the lobby side walls.
    for(const z of [-46,-41,-36]){
      for(const x of [-34,34]) {
        prop({floor:1,x,z,w:.28,h:2.5,d:2.15,localY:1.45,material:'dark',collider:true,id:`poster-${x}-${z}`});
        addSign({floor:1,text:z===-46?'MIDNIGHT':z===-41?'THE LAST GUEST':'NO WAY HOME',x:x+(x<0?.16:-.16),z,rotationY:x<0?HALF_TURN:-HALF_TURN,w:1.9,h:1.5,localY:1.55});
      }
    }

    const doorClearance=[];
    function seat({aud,rowX,seatZ,topY,facing}){
      const rear = facing==='west' ? 1 : -1;
      prop({floor:1,x:rowX,z:seatZ,w:.72,h:.14,d:.72,localY:topY+.43,material:'red',collider:false});
      prop({floor:1,x:rowX + rear*.31,z:seatZ,w:.12,h:.82,d:.74,localY:topY+.78,material:'red',collider:false});
      prop({floor:1,x:rowX,z:seatZ-.39,w:.62,h:.33,d:.08,localY:topY+.58,material:'dark',collider:false});
      prop({floor:1,x:rowX,z:seatZ+.39,w:.62,h:.33,d:.08,localY:topY+.58,material:'dark',collider:false});
    }

    function buildAuditorium(aud){
      const west=aud.side==='west', fixedInner=west?aud.maxX:aud.minX, fixedOuter=west?aud.minX:aud.maxX;
      const innerDir=west?1:-1, width=2.2;
      const screenD=aud.seatMaxZ-aud.seatMinZ+.5;
      const screenH=aud.tier==='large'?5.5:aud.tier==='medium'?4.9:4.4;
      const rows=aud.tier==='large'?8:aud.tier==='medium'?7:6;
      const seatsPerBank=aud.tier==='large'?6:aud.tier==='medium'?5:4;
      const entryOpening={center:aud.entryZ,width,height:2.45};
      const exitOpening={center:aud.serviceExitZ,width:1.9,height:2.45};

      // Double-height shell. Inner wall stops at the mezzanine datum so booths can bridge over it.
      if(aud.id==='306') {
        wallX({floor:1,x:36,z:aud.minZ,width:40,height:FLOOR_H,material:'dark'});
        splitWall({floor:1,axis:'x',fixed:aud.minZ,from:16,to:56,base:FLOOR_H,height:AUD_H-FLOOR_H,
          openings:[{center:24,width:6,height:2.6}],material:'dark'});
      } else wallX({floor:1,x:(aud.minX+aud.maxX)/2,z:aud.minZ,width:aud.maxX-aud.minX,height:AUD_H,material:'dark'});
      wallX({floor:1,x:(aud.minX+aud.maxX)/2,z:aud.maxZ,width:aud.maxX-aud.minX,height:AUD_H,material:'dark'});
      if(west){
        splitWall({floor:1,axis:'z',fixed:aud.maxX,from:aud.minZ,to:aud.maxZ,openings:[entryOpening],height:FLOOR_H,material:'dark'});
        splitWall({floor:1,axis:'z',fixed:aud.minX,from:aud.minZ,to:aud.maxZ,openings:[exitOpening],height:AUD_H,material:'dark'});
      }else{
        splitWall({floor:1,axis:'z',fixed:aud.minX,from:aud.minZ,to:aud.maxZ,openings:[entryOpening],height:FLOOR_H,material:'dark'});
        splitWall({floor:1,axis:'z',fixed:aud.maxX,from:aud.minZ,to:aud.maxZ,openings:[exitOpening],height:AUD_H,material:'dark'});
      }
      // Cinema sound-lock: the public door opens into a short side vestibule, then the player
      // turns through this offset internal opening before reaching the raised rear seating landing.
      const soundLockZ=aud.minZ+5.2;
      const soundFrom=west?aud.maxX-6.0:aud.minX;
      const soundTo=west?aud.maxX:aud.minX+6.0;
      const soundOpening=west?aud.maxX-4.1:aud.minX+4.1;
      splitWall({floor:1,axis:'x',fixed:soundLockZ,from:soundFrom,to:soundTo,openings:[{center:soundOpening,width:2.2,height:2.45}],height:2.9,material:'dark'});
      ceilingRect({floor:1,minX:aud.minX,maxX:aud.maxX,minZ:aud.minZ,maxZ:aud.maxZ,height:AUD_H});

      // Public door, already open for geometry review.
      const openAngle=west?-HALF_TURN:HALF_TURN;
      const leaf=hingedLeaf({id:`door-${aud.id}`,floor:1,fixed:fixedInner,center:aud.entryZ,width,openAngle,extra:{roomNumber:aud.id,locked:false,requiredKey:null,openInitially:true}});
      roomDoors.push(leaf); swingDoors.push(leaf); doorFrame({floor:1,axis:'z',fixed:fixedInner,center:aud.entryZ,width,material:'brass'});
      doorFrame({floor:1,axis:'z',fixed:fixedOuter,center:aud.serviceExitZ,width:1.9,material:'metal'});
      addSign({floor:1,text:aud.name,x:fixedInner + (west?.18:-.18),z:aud.entryZ,rotationY:west?HALF_TURN:-HALF_TURN,w:4.0,h:.62,localY:2.82});
      addSign({floor:1,text:'EXIT',x:fixedOuter + (west?.18:-.18),z:aud.serviceExitZ,rotationY:west?-HALF_TURN:HALF_TURN,w:1.6,h:.5,localY:2.55});
      doorClearance.push({room:aud.id,floor:1,minX:west?fixedInner-4:fixedInner-.2,maxX:west?fixedInner+.2:fixedInner+4,minZ:aud.entryZ-2,maxZ:aud.entryZ+2});

      // The continuous Floor-1 slab already forms the side/service aisle and sound-lock floor.

      // Tiered audience floor. Rear is only ~0.55m high, so the engine's 0.62m snap can traverse row boundaries.
      const screenEdge=west?aud.minX+6.2:aud.maxX-6.2;
      const rearEdge=west?aud.maxX-4.4:aud.minX+4.4;
      const total=Math.abs(rearEdge-screenEdge), band=total/rows;
      const rowRecords=[];
      for(let i=0;i<rows;i++){
        const topY=.08 + (.47*(i/(rows-1)));
        let minX,maxX,rowX;
        if(west){ minX=screenEdge+i*band; maxX=screenEdge+(i+1)*band; rowX=(minX+maxX)/2; }
        else { maxX=screenEdge-i*band; minX=screenEdge-(i+1)*band; rowX=(minX+maxX)/2; }
        slabRect({floor:1,minX,maxX,minZ:aud.seatMinZ,maxZ:aud.maxZ,material:'carpetRed',topY,priority:1});
        rowRecords.push({minX,maxX,rowX,topY});
        // visible riser face at the rear edge of each band
        const riserX=west?maxX:minX;
        prop({floor:1,x:riserX,z:(aud.seatMinZ+aud.maxZ)/2,w:.1,h:topY,d:aud.maxZ-aud.seatMinZ,localY:topY/2,material:'darker',collider:false});
      }

      // Rear landing under the projection booth; same height as the last seating band.
      const rearTop=.55;
      if(west) slabRect({floor:1,minX:rearEdge,maxX:aud.maxX,minZ:aud.seatMinZ,maxZ:aud.maxZ,material:'carpetRed',topY:rearTop,priority:1});
      else slabRect({floor:1,minX:aud.minX,maxX:rearEdge,minZ:aud.seatMinZ,maxZ:aud.maxZ,material:'carpetRed',topY:rearTop,priority:1});

      // A short side ramp connects the flat sound-lock aisle to the raised rear landing.
      const rampMinX=west?aud.maxX-5.6:aud.minX+2.0, rampMaxX=west?aud.maxX-2.0:aud.minX+5.6;
      surfaces.push({kind:'ramp',floor:1,priority:3,minX:clean(Math.min(rampMinX,rampMaxX)),maxX:clean(Math.max(rampMinX,rampMaxX)),minZ:clean(aud.seatMinZ-2.8),maxZ:clean(aud.seatMinZ+.2),startZ:clean(aud.seatMinZ-2.8),endZ:clean(aud.seatMinZ+.2),startY:0,endY:rearTop});
      // visual ramp deck
      prop({floor:1,x:(rampMinX+rampMaxX)/2,z:aud.seatMinZ-1.3,w:Math.abs(rampMaxX-rampMinX),h:.12,d:3.0,localY:.24,material:'carpetRed',collider:false,rotationY:0});

      // Real seat silhouettes: cushion + back + two armrests. Collision is one invisible row-bank record.
      const centerZ=(aud.seatMinZ+aud.seatMaxZ)/2;
      const leftA=aud.seatMinZ+1.0, leftB=centerZ-1.35, rightA=centerZ+1.35, rightB=aud.seatMaxZ-1.0;
      function bank(row, a, b, label){
        const span=b-a, count=seatsPerBank;
        for(let s=0;s<count;s++){
          const z=count===1?(a+b)/2:a+(span*s/(count-1)); seat({aud,rowX:row.rowX,seatZ:z,topY:row.topY,facing:west?'west':'east'});
        }
        box({floor:1,group:'furnishing',kind:'furnishing',material:'dark',collider:true,x:row.rowX,localY:row.topY+.55,z:(a+b)/2,w:.92,h:1.1,d:Math.max(.7,b-a+.8),id:`${aud.id}-${label}-${clean(row.rowX)}`});
      }
      for(const row of rowRecords){ bank(row,leftA,leftB,'bank-a'); bank(row,rightA,rightB,'bank-b'); }

      // Screen, masking and stage. Screen deliberately dominates the outer wall.
      const screenX=fixedOuter + (west?.26:-.26), stageX=fixedOuter + innerDir*2.5;
      const screenCenterZ=(aud.seatMinZ+aud.seatMaxZ)/2;
      prop({floor:1,x:screenX,z:screenCenterZ,w:.16,h:screenH,d:screenD,localY:3.0,material:'screen',collider:false,id:`screen-${aud.id}`});
      prop({floor:1,x:screenX+innerDir*.08,z:screenCenterZ,w:.18,h:.32,d:screenD+.8,localY:.33,material:'black',collider:false});
      prop({floor:1,x:screenX+innerDir*.08,z:screenCenterZ,w:.18,h:.32,d:screenD+.8,localY:5.78,material:'black',collider:false});
      prop({floor:1,x:stageX,z:screenCenterZ,w:4.2,h:.3,d:aud.seatMaxZ-aud.seatMinZ,localY:.15,material:'black',collider:true,id:`stage-${aud.id}`});

      // Acoustic side panels + low aisle lights.
      for(let px=(west?aud.minX+8:aud.maxX-8); west?px<aud.maxX-6:px>aud.minX+6; px+=west?6:-6){
        prop({floor:1,x:px,z:aud.maxZ-.18,w:3.2,h:2.6,d:.12,localY:1.55,material:'red',collider:false});
        prop({floor:1,x:px,z:aud.seatMinZ+.18,w:3.2,h:2.6,d:.12,localY:1.55,material:'darker',collider:false});
      }
      for(const row of rowRecords){
        prop({floor:1,x:row.rowX,z:centerZ-.95,w:.22,h:.09,d:.22,localY:row.topY+.1,material:'redLight',collider:false});
        prop({floor:1,x:row.rowX,z:centerZ+.95,w:.22,h:.09,d:.22,localY:row.topY+.1,material:'redLight',collider:false});
      }
      pointLight({floor:1,x:screenX+innerDir*4,z:screenCenterZ,localY:2.7,color:0x551019,intensity:.18,distance:11});
      pointLight({floor:1,x:fixedInner+innerDir*5,z:screenCenterZ,localY:2.8,color:0x2c080b,intensity:.22,distance:9});

      const targetX=west?-32:32;
      roomCenters.push({roomNumber:aud.id,floor:1,x:clean(targetX),z:clean(centerZ),side:leaf.side,minX:aud.minX,maxX:aud.maxX,minZ:aud.minZ,maxZ:aud.maxZ});
    }
    for(const aud of AUDITORIUMS) buildAuditorium(aud);

    // The reference's continuous projection slab stays intact. Both stairs terminate at its south
    // edge; the game-owned lift has a separate landing wing with an explicit shaft cutout.
    slabRect({floor:2,minX:-28,maxX:28,minZ:-18,maxZ:46,material:'service'});
    splitWall({
      floor:2,axis:'x',fixed:-18,from:-28,to:28,
      openings:[{center:-14,width:4.4,height:2.6},{center:14,width:4.4,height:2.6},{center:24,width:6,height:2.6}],
      height:3.05,material:'dark'
    });
    wallX({floor:2,x:0,z:46,width:56,height:3.05,material:'dark'});

    function windowWall({floor,fixed,minZ,maxZ,center,width=3.2,height=3.0,material='dark',glassSide=1}){
      const low=center-width/2, high=center+width/2;
      wallZ({floor,x:fixed,z:(minZ+low)/2,depth:low-minZ,height,material});
      wallZ({floor,x:fixed,z:(high+maxZ)/2,depth:maxZ-high,height,material});
      box({floor,kind:'wall',material,x:fixed,localY:.55,z:center,w:.22,h:1.1,d:width});
      box({floor,kind:'wall',material,x:fixed,localY:2.68,z:center,w:.22,h:.64,d:width});
      prop({floor,x:fixed+glassSide*.025,z:center,w:.05,h:1.05,d:width-.18,localY:1.72,material:'glass',collider:false});
    }

    function rack({floor,x,z,alongZ=true,id}){
      const w=alongZ?.75:4.2,d=alongZ?4.2:.75;
      box({floor,group:'furnishing',kind:'furnishing',material:'dark',collider:true,x,localY:1.0,z,w,h:2,d,id});
      const offs=alongZ?[[-.3,-1.8],[-.3,1.8],[.3,-1.8],[.3,1.8]]:[[-1.8,-.3],[1.8,-.3],[-1.8,.3],[1.8,.3]];
      for(const [dx,dz] of offs) prop({floor,x:x+dx,z:z+dz,w:.08,h:2,d:.08,localY:1,material:'metal',collider:false});
      for(const yy of [.28,.72,1.16,1.6]) prop({floor,x,z,w,h:.07,d,localY:yy,material:'metal',collider:false});
    }

    function buildBooth(booth,index){
      const west=booth.side==='west', fixedInner=west?booth.maxX:booth.minX, fixedView=west?booth.minX:booth.maxX;
      wallX({floor:2,x:(booth.minX+booth.maxX)/2,z:booth.minZ,width:booth.maxX-booth.minX,height:3.05,material:'dark'});
      wallX({floor:2,x:(booth.minX+booth.maxX)/2,z:booth.maxZ,width:booth.maxX-booth.minX,height:3.05,material:'dark'});
      splitWall({floor:2,axis:'z',fixed:fixedInner,from:booth.minZ,to:booth.maxZ,openings:[{center:booth.entryZ,width:1.9,height:2.4}],height:3.05,material:'dark'});
      windowWall({floor:2,fixed:fixedView,minZ:booth.minZ,maxZ:booth.maxZ,center:booth.entryZ,width:3.4,height:3.05,material:'dark',glassSide:west?-1:1});
      const openAngle=west?-HALF_TURN:HALF_TURN;
      const leaf=hingedLeaf({id:`door-${booth.id}`,floor:2,fixed:fixedInner,center:booth.entryZ,width:1.9,openAngle,extra:{roomNumber:booth.id,locked:false,requiredKey:null,openInitially:true}});
      roomDoors.push(leaf); swingDoors.push(leaf); doorFrame({floor:2,axis:'z',fixed:fixedInner,center:booth.entryZ,width:1.9,material:'metal'});
      addSign({floor:2,text:booth.name,x:fixedInner+(west?.16:-.16),z:booth.entryZ,rotationY:west?HALF_TURN:-HALF_TURN,w:3.9,h:.56,localY:2.67});
      doorClearance.push({room:booth.id,floor:2,minX:west?fixedInner-3.3:fixedInner-.2,maxX:west?fixedInner+.2:fixedInner+3.3,minZ:booth.entryZ-1.8,maxZ:booth.entryZ+1.8});

      const projectorX=west?fixedView+2.2:fixedView-2.2;
      // Projector pedestal, body, lens and twin reel housings.
      prop({floor:2,x:projectorX,z:booth.entryZ,w:1.7,h:.9,d:1.3,localY:.45,material:'metal',collider:true,id:`projector-pedestal-${booth.id}`});
      prop({floor:2,x:projectorX,z:booth.entryZ,w:1.25,h:.7,d:1.0,localY:1.22,material:'dark',collider:false});
      prop({floor:2,x:projectorX+(west?-.75:.75),z:booth.entryZ,w:.4,h:.38,d:.38,localY:1.27,material:'brass',collider:false});
      prop({floor:2,x:projectorX,z:booth.entryZ-.72,w:.18,h:1.05,d:1.05,localY:1.78,material:'metal',collider:false});
      prop({floor:2,x:projectorX,z:booth.entryZ+.72,w:.18,h:1.05,d:1.05,localY:1.78,material:'metal',collider:false});
      // Control desk and open-frame storage rack sit away from the door centerline.
      const deskZ=booth.minZ+1.0; place('desk',2,west?booth.minX+3.0:booth.maxX-3.0,deskZ,west?HALF_TURN:-HALF_TURN,{label:'projection console'});
      rack({floor:2,x:(booth.minX+booth.maxX)/2,z:booth.maxZ-.58,alongZ:false,id:`rack-${booth.id}`});
      pointLight({floor:2,x:(booth.minX+booth.maxX)/2,z:booth.entryZ,localY:2.45,color:0x6b2416,intensity:.32,distance:5.5});
      roomCenters.push({roomNumber:booth.id,floor:2,x:clean((booth.minX+booth.maxX)/2),z:clean(booth.entryZ+1.4),side:leaf.side,minX:booth.minX,maxX:booth.maxX,minZ:booth.minZ,maxZ:booth.maxZ});
    }
    BOOTHS.forEach(buildBooth);

    // Close the exposed mezzanine edges between projection booths. The viewing-wall segments remain
    // the only openings toward the auditoriums, so Floor 2 cannot spill into an unguarded void.
    for(const side of ['west','east']){
      const x=side==='west'?-28:28;
      const spans=BOOTHS.filter(b=>b.side===side).slice().sort((a,b)=>a.minZ-b.minZ);
      let cursor=-18;
      for(const b of spans){
        if(b.minZ>cursor+.02) wallZ({floor:2,x,z:(cursor+b.minZ)/2,depth:b.minZ-cursor,height:3.05,material:'dark'});
        cursor=Math.max(cursor,b.maxZ);
      }
      if(cursor<46-.02) wallZ({floor:2,x,z:(cursor+46)/2,depth:46-cursor,height:3.05,material:'dark'});
    }

    // One roof over the entire projection mezzanine. There are no open floor voids beneath it.
    ceilingRect({floor:2,minX:-28,maxX:28,minZ:-18,maxZ:46,height:3.05});
    addSign({floor:2,text:'PROJECTION',x:0,z:-17.78,rotationY:0,w:5.2,h:.7,localY:2.65});
    for(const z of [-14,0,14,28,42]){
      prop({floor:2,x:-7.75,z,w:.1,h:1.8,d:2.4,localY:1.2,material:'metal',collider:false});
      prop({floor:2,x:7.75,z,w:.1,h:1.8,d:2.4,localY:1.2,material:'metal',collider:false});
      pointLight({floor:2,x:0,z,localY:2.55,color:0x6a1111,intensity:.34,distance:8});
    }

    // Two independent physical projection stairs. They are straight runs positioned SOUTH of the
    // mezzanine, so they do not require holes in Floor 2. Each ramp ends exactly at z=-18, where the
    // continuous mezzanine begins.
    const stairLayouts=[];
    for(const spec of STAIRS){
      const steps=28;
      const flight={
        transition:1,lane:spec.id.includes('west')?'west':'east',
        startX:spec.x,startZ:spec.startZ,endX:spec.x,endZ:spec.endZ,
        startY:0,endY:FLOOR_H,width:spec.width,steps,
        railSide:spec.id.includes('west')?-1:1
      };
      const layoutData={
        entrances:[
          {floor:1,x:spec.x,z:spec.startZ-1.0,y:0},
          {floor:2,x:spec.x,z:spec.endZ+.8,y:FLOOR_H}
        ],
        landings:[],
        flights:[flight]
      };
      stairLayouts.push({spec,layout:layoutData});
      surfaces.push({
        kind:'ramp',floor:0,priority:5,
        minX:spec.x-spec.width/2,maxX:spec.x+spec.width/2,
        minZ:spec.startZ,maxZ:spec.endZ,
        startZ:spec.startZ,endZ:spec.endZ,startY:0,endY:FLOOR_H
      });
      for(let i=0;i<steps;i++){
        const t=(i+.5)/steps;
        stairs.treads.push({
          x:spec.x,
          y:clean(FLOOR_H*((i+1)/steps)-.055),
          z:clean(spec.startZ+(spec.endZ-spec.startZ)*t),
          w:spec.width,h:.11,
          d:clean(Math.abs(spec.endZ-spec.startZ)/steps+.035),
          rotationY:0,material:'metal'
        });
      }
      for(const side of [-1,1]){
        const rx=spec.x+side*(spec.width/2+.06);
        stairs.rails.push({
          start:{x:rx,y:.9,z:spec.startZ},
          end:{x:rx,y:FLOOR_H+.9,z:spec.endZ}
        });
      }
      // Enclosed lower run. Walls stop 1.4m before the mezzanine so the stair visibly opens into
      // Floor 2 instead of ending at a wall.
      for(const x of [spec.minX,spec.maxX]){
        wallZ({
          floor:1,x,
          z:(spec.startZ+(spec.endZ-1.4))/2,
          depth:(spec.endZ-1.4)-spec.startZ,
          base:0,height:FLOOR_H+.25,material:'dark'
        });
      }
      addSign({
        floor:1,text:'PROJECTION STAIRS',x:spec.x,z:spec.startZ-.66,
        rotationY:Math.PI,w:4.1,h:.54,localY:2.65
      });
    }

    // Upper lift landing joins the south end of projection through the opening at x=24.
    tiledArea({floor:2,minX:20,maxX:48,minZ:-42,maxZ:-18,material:'service',exclude:[liftVoid]});
    ceilingRect({floor:2,minX:20,maxX:48,minZ:-42,maxZ:-18,height:3.05});
    wallX({floor:2,x:34,z:-42,width:28,height:3.05,material:'dark'});
    wallX({floor:2,x:38,z:-18,width:20,height:3.05,material:'dark'});
    for(const x of [20,48]) wallZ({floor:2,x,z:-30,depth:24,height:3.05,material:'dark'});
    for(const x of [liftVoid.minX,liftVoid.maxX]) wallZ({floor:1,x,z:LIFT.centerZ,depth:3.2,height:SHELL_H,material:'dark'});
    wallX({floor:1,x:42,z:-34.4,width:3,height:SHELL_H,material:'dark'});
    for(const floor of [1,2]) {
      splitWall({floor,axis:'x',fixed:LIFT.frontZ,from:40.5,to:43.5,openings:[{center:42,width:2.1,height:2.4}],material:'dark'});
      doorFrame({floor,axis:'x',fixed:LIFT.frontZ,center:42,width:2.1,height:2.4});
      addSign({floor,text:'ELEVATOR',x:42,z:-37.8,rotationY:Math.PI,w:2.8,h:.45,localY:2.7});
      for(const side of ['left','right']) {
        const direction=side==='left'?-1:1;
        const leaf={id:`hall-door-${floor}-${side}`,kind:'hall',floor,side,direction,centerX:42,x:42+direction*.46,y:levelY(floor)+1.175,z:-37.68,w:.92,h:2.35,d:.08};
        hallDoors.push(leaf);slidingDoors.push(leaf);
      }
      box({floor,kind:'call-button',material:'brass',collider:false,x:43.92,z:-37.815,localY:1.25,w:.11,h:.18,d:.04,callFloor:floor,id:`elevator-call-${floor}`});
      pointLight({floor,x:42,z:-40,localY:2.6,color:0xc08a45,intensity:.7,distance:9});
    }
    surfaces.push({kind:'dynamic',id:'elevator-car',floor:0,priority:2,minX:40.84,maxX:43.16,minZ:-37.72,maxZ:-34.53});
    addSign({floor:2,text:'PROJECTION 1 - 6',x:24,z:-18.15,rotationY:Math.PI,w:5,h:.55,localY:2.7});
    place('couch',2,32,-23,0);
    place('vending',2,46,-26,-HALF_TURN);

    // Searchable support rooms. Keep the six theater loops open; locks belong to staff spaces.
    for(const r of [
      {id:'307',name:'FILM STORE',minX:36,maxX:48,minZ:-29,maxZ:-20,front:48,x:44,locked:true},
      {id:'308',name:'RESTROOMS',minX:20,maxX:32,minZ:-29,maxZ:-20,front:20,x:25,locked:false}
    ]) {
      for(const z of [r.minZ,r.maxZ]) wallX({floor:1,x:(r.minX+r.maxX)/2,z,width:r.maxX-r.minX,material:'dark'});
      wallZ({floor:1,x:r.front===r.minX?r.maxX:r.minX,z:-24.5,depth:9,material:'dark'});
      splitWall({floor:1,axis:'z',fixed:r.front,from:r.minZ,to:r.maxZ,openings:[{center:-24.5,width:2.2,height:2.4}],material:'dark'});
      const leaf=hingedLeaf({id:`door-${r.id}`,floor:1,fixed:r.front,center:-24.5,width:2.2,openAngle:r.front===r.minX?HALF_TURN:-HALF_TURN,
        extra:{roomNumber:r.id,locked:r.locked,requiredKey:r.locked?keyIdForFloor(1):null,openInitially:!r.locked}});
      roomDoors.push(leaf);swingDoors.push(leaf);
      roomCenters.push({roomNumber:r.id,floor:1,x:r.x,z:-24.5,side:leaf.side,minX:r.minX,maxX:r.maxX,minZ:r.minZ,maxZ:r.maxZ});
      doorFrame({floor:1,axis:'z',fixed:r.front,center:-24.5,width:2.2});
      addSign({floor:1,text:r.name,x:r.front+(r.front===r.minX?-.16:.16),z:-24.5,rotationY:r.front===r.minX?-HALF_TURN:HALF_TURN,w:3.5,h:.55,localY:2.75});
    }
    for(const x of [22,26,30]) {
      prop({floor:1,x,z:-21.3,w:1,h:.7,d:1.15,material:'linen',collider:true,id:`restroom-fixture-${x}`});
      wallZ({floor:1,x:x-1.3,z:-21.6,depth:2.7,height:2.2,material:'metal'});
    }
    for(const x of [38,41,44]) rack({floor:1,x,z:-21,alongZ:false,id:`film-rack-${x}`});
    place('dresser',1,-8,-46,0,{keyId:keyIdForFloor(1),keyLabel:keyLabelForFloor(1),label:'box office master-key drawer'});
    place('dresser',1,38,-27,0,{label:'film inventory'});
    place('dresser',2,-14,BOOTHS[0].minZ+1,0,{keyId:keyIdForFloor(2),keyLabel:keyLabelForFloor(2),label:'projection master-key drawer'});
    for(const id of ['402','405']) {
      const door=roomDoors.find(d=>d.roomNumber===id);
      Object.assign(door,{locked:true,requiredKey:keyIdForFloor(2),openInitially:false});
    }
    // Low seating and offset pillars break long sightlines without closing the cross-halls.
    for(const z of [-8,12,34]) for(const side of [-1,1]) {
      prop({floor:1,x:side*7,z,w:1.4,h:3.2,d:1.4,material:'dark',collider:true,id:`foyer-pillar-${side}-${z}`});
      place('couch',1,side*10,z+2,side<0?HALF_TURN:-HALF_TURN);
      addSign({floor:1,text:side<0?'SCREENS 1 - 3':'SCREENS 4 - 6',x:side*7,z:z-.76,rotationY:Math.PI,w:3.1,h:.45,localY:2.7});
    }

    // Public + service lighting.
    for(const [x,z] of [[0,-44],[-20,-39],[20,-39],[0,-34],[-10,-26],[10,-26],[0,-12],[0,10],[0,32],[-59,-10],[59,-10],[-59,14],[59,14],[-59,36],[59,36]]){
      prop({floor:1,x,z,w:.7,h:.08,d:.28,localY:2.72,material:'redLight',collider:false}); pointLight({floor:1,x,z});
    }

    const navigationApi = root?.CinemaNavigation || (typeof require === 'function' ? require('./cinema-navigation.js') : null);
    const navigation = navigationApi.createCinemaNavigation({ auditoriums:AUDITORIUMS, booths:BOOTHS, stairLayouts, rooms:roomCenters });
    const spawns={
      seeker:{floor:1,x:LIFT.centerX,z:LIFT.centerZ+.25,y:0},
      hiders:[
        {floor:1,x:0,z:-44,y:0},{floor:1,x:-18,z:-44,y:0},
        {floor:1,x:18,z:-44,y:0},{floor:1,x:0,z:-16,y:0},
        {floor:2,x:0,z:-7,y:FLOOR_H},{floor:2,x:0,z:13,y:FLOOR_H},
        {floor:2,x:-14,z:14.5,y:FLOOR_H},{floor:2,x:14,z:-6,y:FLOOR_H}
      ]
    };
    spawns.flashlights = [
      // The flat front cross-aisles, below the tiered seating and away from exit leaves.
      ...AUDITORIUMS.map(aud => ({ id:`cinema-${aud.id}`, label:`${aud.name} front aisle`,
        floor:1, x:aud.side === 'west' ? -30 : 30, z:aud.minZ + 3.5, y:0 })),
      // Projection staff leave spare lights on the clear floor beside each booth entrance.
      ...BOOTHS.map(booth => ({ id:`cinema-${booth.id}`, label:`${booth.name} entry aisle`,
        floor:2, x:booth.side === 'west' ? -16 : 16, z:booth.entryZ - 1.7, y:FLOOR_H })),
    ];
    const colliders=boxes.filter(e=>e.collider).map(e=>({...boxBounds(e),id:e.id||null,floor:e.floor}));

    return {elevator:{centerX:LIFT.centerX,centerZ:LIFT.centerZ,frontZ:LIFT.frontZ,halfWidth:LIFT.halfWidth,halfDepth:LIFT.halfDepth,floors:[1,2]},boxes,surfaces,colliders,swingDoors,slidingDoors,roomDoors,secretPanels,secretTunnels,roomCenters,furnishings,hallDoors,signs,doorFrames,wallLamps,lights,fixtures,stairs,spawns,navigation,
      inspectionViews:{lobby:{x:0,y:1.7,z:-44,yaw:Math.PI,pitch:0},theater1:{x:-24,y:2.25,z:38,yaw:HALF_TURN,pitch:0},projection:{x:0,y:FLOOR_H+1.7,z:10,yaw:Math.PI,pitch:0},lift:{x:42,y:1.7,z:-41,yaw:Math.PI,pitch:0},landing:{x:24,y:FLOOR_H+1.7,z:-39,yaw:Math.PI,pitch:0}},qa:{doorClearance,auditoriums:AUDITORIUMS,booths:BOOTHS,stairs:STAIRS}};
  }

  return {...geometry,FLOOR_DEFS,createCinemaPlan};
});
