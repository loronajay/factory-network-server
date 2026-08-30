(function attachHospitalPlan(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HospitalPlan = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHospitalPlanApi(root) {
  'use strict';

  const geometry = root?.HotelCollision || (typeof require === 'function' ? require('./collision-logic.js') : null);
  if (!geometry) throw new Error('Saint Mercy V5 requires HotelCollision.');

  const HALF_TURN = Math.PI / 2;
  const WALL_H = 3.2;
  const SHELL = Object.freeze({ minX: -42, maxX: 42, minZ: -32, maxZ: 32 });

  // Hospital-specific circulation:
  // three north/south spines linked by a wide east/west main hall.
  const HALL_X = Object.freeze([-25, 0, 25]);

  // Dedicated service cores. Neither overlaps a department.
  const STAIR = Object.freeze({
    xWest: 30.5, xEast: 40.5, zSouth: 6.5, zNorth: 19.5,
    westLane: 32.5, eastLane: 38.5, landingX: 35.5,
    doorZ: 10.5, doorWidth: 2.2,
  });
  // Exact cabin dimensions used by modules/elevator.js: 2.5m wide x 3.2m deep.
  const LIFT = Object.freeze({
    centerX: 35.5, centerZ: 27.5, frontZ: 25.9,
    halfWidth: 1.25, halfDepth: 1.6,
  });

  const FLOOR_DEFS = Object.freeze([
    Object.freeze({ id: 1, name: 'Emergency & Diagnostics' }),
    Object.freeze({ id: 2, name: 'Patient & Critical Care' }),
  ]);

  // Every department opens onto one of the three vertical hospital corridors.
  // Restricting normal doors to east/west faces deliberately reuses the proven door axis.
  // A `locked` department needs its floor's master key; the master hangs in a drawer inside an open
  // department on the same floor, so the key loop is walkable without a key.
  const ROOMS = Object.freeze([
    // Ground floor.
    Object.freeze({ id:'101', floor:1, name:'EMERGENCY', minX:-41.5,maxX:-29.5,minZ:-31.5,maxZ:-5.5, front:'east', entry:-18 }),
    Object.freeze({ id:'102', floor:1, name:'CAFETERIA', minX:-18.5,maxX:-5.5,minZ:-31.5,maxZ:-5.5, front:'east', entry:-18 }),
    Object.freeze({ id:'103', floor:1, name:'PHARMACY', minX:5.5,maxX:20,minZ:-31.5,maxZ:-5.5, front:'west', entry:-18, locked:true }),
    Object.freeze({ id:'104', floor:1, name:'IMAGING', minX:30.5,maxX:41.5,minZ:-31.5,maxZ:-5.5, front:'west', entry:-18, locked:true }),
    Object.freeze({ id:'105', floor:1, name:'LABORATORY', minX:-41.5,maxX:-29.5,minZ:5.5,maxZ:31.5, front:'east', entry:18 }),
    Object.freeze({ id:'106', floor:1, name:'SURGERY', minX:-18.5,maxX:-5.5,minZ:5.5,maxZ:31.5, front:'east', entry:18 }),
    Object.freeze({ id:'107', floor:1, name:'RECOVERY', minX:5.5,maxX:20,minZ:5.5,maxZ:31.5, front:'west', entry:18 }),

    // Upper floor.
    Object.freeze({ id:'201', floor:2, name:'PATIENT WARD A', minX:-41.5,maxX:-29.5,minZ:-31.5,maxZ:-5.5, front:'east', entry:-18 }),
    Object.freeze({ id:'202', floor:2, name:'ADMINISTRATION', minX:-18.5,maxX:-5.5,minZ:-31.5,maxZ:-5.5, front:'east', entry:-18, locked:true }),
    Object.freeze({ id:'203', floor:2, name:'ISOLATION', minX:5.5,maxX:20,minZ:-31.5,maxZ:-5.5, front:'west', entry:-18, locked:true }),
    Object.freeze({ id:'204', floor:2, name:'ICU', minX:30.5,maxX:41.5,minZ:-31.5,maxZ:-5.5, front:'west', entry:-18 }),
    Object.freeze({ id:'205', floor:2, name:'PATIENT WARD B', minX:-41.5,maxX:-29.5,minZ:5.5,maxZ:31.5, front:'east', entry:18 }),
    Object.freeze({ id:'206', floor:2, name:'NURSES / MEDS', minX:-18.5,maxX:-5.5,minZ:5.5,maxZ:31.5, front:'east', entry:18 }),
    Object.freeze({ id:'207', floor:2, name:'REHAB / CHAPEL', minX:5.5,maxX:20,minZ:5.5,maxZ:31.5, front:'west', entry:18 }),
  ]);

  const clean = (v) => (Math.abs(v) < 1e-12 ? 0 : Number(Number(v).toFixed(9)));
  const { boxBounds } = geometry;

  function createHospitalPlan({ config, floorDefs = FLOOR_DEFS, layout, floorY, keyIdForFloor, keyLabelForFloor }) {
    const FLOOR_H = config.floorHeight;
    const SHELL_H = FLOOR_H * floorDefs.length;
    const boxes=[], surfaces=[], swingDoors=[], slidingDoors=[], roomDoors=[],
      secretPanels=[], secretTunnels=[], roomCenters=[], furnishings=[], hallDoors=[],
      signs=[], doorFrames=[], wallLamps=[], lights=[], fixtures=[];
    const stairs={treads:[],rails:[]};

    const levelY=(floor)=>(floor-1)*FLOOR_H;

    function box({floor,group='floor',kind,material='wall',collider=true,x,localY,z,w,h,d,rotationY=0,id=null,callFloor=null}) {
      boxes.push({
        floor,group,kind,material,collider,id,callFloor,
        x:clean(x),y:clean(levelY(floor)+localY),z:clean(z),
        w:clean(w),h:clean(h),d:clean(d),rotationY,localY:clean(localY)
      });
    }
    function wallX({floor,x,z,width,base=0,height=WALL_H,material='wall'}) {
      if(width>.02) box({floor,kind:'wall',material,x,localY:base+height/2,z,w:width,h:height,d:.22});
    }
    function wallZ({floor,x,z,depth,base=0,height=WALL_H,material='wall'}) {
      if(depth>.02) box({floor,kind:'wall',material,x,localY:base+height/2,z,w:.22,h:height,d:depth});
    }
    function splitWall({floor,axis,fixed,from,to,openings=[],base=0,height=WALL_H,material='wall'}) {
      const sorted=openings.slice().sort((a,b)=>a.center-b.center);
      let cursor=from;
      for(const opening of sorted){
        const low=opening.center-opening.width/2;
        const high=opening.center+opening.width/2;
        if(low>cursor+.02){
          const c=(cursor+low)/2,l=low-cursor;
          axis==='x'?wallX({floor,x:c,z:fixed,width:l,base,height,material})
                    :wallZ({floor,x:fixed,z:c,depth:l,base,height,material});
        }
        const clearance=opening.height||2.35;
        const hh=Math.max(.15,height-clearance);
        const hy=base+clearance+hh/2;
        axis==='x'
          ? box({floor,kind:'wall',material,x:opening.center,localY:hy,z:fixed,w:opening.width,h:hh,d:.22})
          : box({floor,kind:'wall',material,x:fixed,localY:hy,z:opening.center,w:.22,h:hh,d:opening.width});
        cursor=high;
      }
      if(cursor<to-.02){
        const c=(cursor+to)/2,l=to-cursor;
        axis==='x'?wallX({floor,x:c,z:fixed,width:l,base,height,material})
                  :wallZ({floor,x:fixed,z:c,depth:l,base,height,material});
      }
    }
    function slabRect({floor,minX,maxX,minZ,maxZ,material,priority=0,localY=-.1}) {
      if(maxX-minX<=.02||maxZ-minZ<=.02)return;
      box({floor,kind:'slab',material,collider:false,x:(minX+maxX)/2,localY,z:(minZ+maxZ)/2,w:maxX-minX,h:.2,d:maxZ-minZ});
      surfaces.push({kind:'rect',floor,priority,minX:clean(minX),maxX:clean(maxX),minZ:clean(minZ),maxZ:clean(maxZ),y:clean(levelY(floor)+(localY+.1))});
    }
    function ceilingRect({floor,minX,maxX,minZ,maxZ,material='ceiling'}) {
      if(maxX-minX<=.02||maxZ-minZ<=.02)return;
      box({floor,kind:'ceiling',material,collider:false,x:(minX+maxX)/2,localY:WALL_H,z:(minZ+maxZ)/2,w:maxX-minX,h:.12,d:maxZ-minZ});
    }

    // Partition a rectangle into non-overlapping cells, omitting reserved voids.
    // This is used for BOTH visible slabs and walk surfaces, preventing coplanar floor overlays.
    function tiledArea({floor,material,ceil=false,exclude=[]}) {
      const xs=[SHELL.minX,SHELL.maxX],zs=[SHELL.minZ,SHELL.maxZ];
      for(const r of exclude){ xs.push(r.minX,r.maxX); zs.push(r.minZ,r.maxZ); }
      xs.sort((a,b)=>a-b); zs.sort((a,b)=>a-b);
      const ux=[...new Set(xs)], uz=[...new Set(zs)];
      for(let xi=0;xi<ux.length-1;xi++)for(let zi=0;zi<uz.length-1;zi++){
        const minX=ux[xi],maxX=ux[xi+1],minZ=uz[zi],maxZ=uz[zi+1];
        const cx=(minX+maxX)/2,cz=(minZ+maxZ)/2;
        if(exclude.some(r=>cx>r.minX&&cx<r.maxX&&cz>r.minZ&&cz<r.maxZ))continue;
        if(ceil) ceilingRect({floor,minX,maxX,minZ,maxZ});
        else slabRect({floor,minX,maxX,minZ,maxZ,material});
      }
    }

    function pointLight({floor,x,z,localY=2.55,color=0x8a1010,intensity=.5,distance=10}) {
      lights.push({floor,kind:'point',color,intensity,distance,decay:2,x:clean(x),y:clean(levelY(floor)+localY),z:clean(z),localY:clean(localY)});
    }
    function doorFrame({floor,axis,fixed,center,width,height=2.35,material='metal'}) {
      const alongZ=axis==='z';
      doorFrames.push({
        floor,axis,
        x:clean(alongZ?fixed-.07:center),
        z:clean(alongZ?center:fixed-.07),
        width:clean(width),height,material,localY:0,y:clean(levelY(floor))
      });
    }
    function hingedLeaf({id,floor,fixed,center,width,openAngle,extra={}}) {
      // All department doors are in walls running along Z.
      return {
        id,kind:'room',floor,
        side:openAngle<0?'left':'right',
        direction:openAngle<0?-1:1,
        x:clean(fixed),z:clean(center),width:clean(width),
        hingeX:clean(fixed),hingeZ:clean(center-width/2),
        y:clean(levelY(floor)+1.06),
        localX:0,localZ:clean(width/2),
        w:.1,h:2.12,d:clean(width),
        openAngle,...extra
      };
    }
    function place(type,floor,x,z,rotationY=0,extra={}) {
      const id=`hospital-${floor}-${furnishings.length+1}`;
      furnishings.push({id,type,floor,x:clean(x),z:clean(z),rotationY,y:clean(levelY(floor)),...extra});
      // Renderer deliberately skips group='furnishing'; these are authoritative collision footprints.
      const dims={
        bed:[2.15,1.05,3.25], couch:[2.1,1.15,1.0], desk:[1.7,1.0,.8],
        dresser:[1.5,1.05,.72], vending:[1.15,2.25,.95], plant:[.7,1.25,.7]
      }[type];
      if(dims){
        let [w,h,d]=dims;
        const quarter=Math.abs(Math.sin(rotationY))>.7;
        if(quarter)[w,d]=[d,w];
        box({floor,group:'furnishing',kind:'furnishing',material:'dark',collider:true,x,localY:h/2,z,w,h,d,id:`${id}-collider`});
      }
      return id;
    }
    function prop({floor,x,z,w,h,d,localY=h/2,material='metal',collider=true,rotationY=0,id=null}) {
      box({floor,kind:'prop',material,collider,x,localY,z,w,h,d,rotationY,id});
    }
    function hiddenCollider({floor,x,z,w,h,d,localY=h/2,id}) {
      box({floor,group:'furnishing',kind:'furnishing',material:'dark',collider:true,x,localY,z,w,h,d,id});
    }

    // --- floors and ceiling voids ---------------------------------------------------------------
    const shaft={
      minX:LIFT.centerX-LIFT.halfWidth,maxX:LIFT.centerX+LIFT.halfWidth,
      minZ:LIFT.frontZ,maxZ:LIFT.centerZ+LIFT.halfDepth
    };
    const stairVoid={minX:STAIR.xWest,maxX:STAIR.xEast,minZ:STAIR.zSouth,maxZ:STAIR.zNorth};
    const stairThreshold={minX:29.35,maxX:30.8,minZ:9.35,maxZ:11.65};
    const liftSill={minX:LIFT.centerX-1.05,maxX:LIFT.centerX+1.05,minZ:LIFT.frontZ-.58,maxZ:LIFT.frontZ};

    for(const def of floorDefs){
      const mat=def.id===1?'floor4':'floor2';
      tiledArea({floor:def.id,material:mat,exclude:[shaft,stairVoid,stairThreshold,liftSill]});
      // Every inter-floor ceiling is cut around BOTH vertical cores.
      tiledArea({floor:def.id,material:'ceiling',ceil:true,exclude:[shaft,stairVoid]});
      slabRect({floor:def.id,minX:stairThreshold.minX,maxX:stairThreshold.maxX,minZ:stairThreshold.minZ,maxZ:stairThreshold.maxZ,material:'wood',priority:1});
      slabRect({floor:def.id,minX:liftSill.minX,maxX:liftSill.maxX,minZ:liftSill.minZ,maxZ:liftSill.maxZ,material:'metal',priority:1});
    }
    // Only the building roof caps the two open cores.
    ceilingRect({floor:2,minX:shaft.minX,maxX:shaft.maxX,minZ:shaft.minZ,maxZ:shaft.maxZ});
    ceilingRect({floor:2,minX:stairVoid.minX,maxX:stairVoid.maxX,minZ:stairVoid.minZ,maxZ:stairVoid.maxZ});

    // Outer shell, full two-floor height. Ground entrance centered on the middle spine.
    splitWall({floor:1,axis:'x',fixed:SHELL.minZ,from:SHELL.minX,to:SHELL.maxX,
      openings:[{center:0,width:4.2,height:3}],base:0,height:SHELL_H,material:'dark'});
    wallX({floor:1,x:0,z:SHELL.maxZ,width:SHELL.maxX-SHELL.minX,base:0,height:SHELL_H,material:'dark'});
    wallZ({floor:1,x:SHELL.minX,z:0,depth:SHELL.maxZ-SHELL.minZ,base:0,height:SHELL_H,material:'dark'});
    wallZ({floor:1,x:SHELL.maxX,z:0,depth:SHELL.maxZ-SHELL.minZ,base:0,height:SHELL_H,material:'dark'});
    doorFrame({floor:1,axis:'x',fixed:SHELL.minZ,center:0,width:4.2,height:3,material:'brass'});
    signs.push({floor:1,text:'SAINT MERCY',x:0,y:5.6,z:SHELL.minZ+.14,rotationY:0,w:10,h:1.1,localY:5.6});

    // --- departments ----------------------------------------------------------------------------
    const doorClearance=[];
    for(const room of ROOMS){
      const {floor,minX,maxX,minZ,maxZ}=room;
      const cx=(minX+maxX)/2,cz=(minZ+maxZ)/2;
      const width=2.05;
      const opening={center:room.entry,width,height:2.4};

      wallX({floor,x:cx,z:minZ,width:maxX-minX});
      wallX({floor,x:cx,z:maxZ,width:maxX-minX});
      if(room.front==='east'){
        wallZ({floor,x:minX,z:cz,depth:maxZ-minZ});
        splitWall({floor,axis:'z',fixed:maxX,from:minZ,to:maxZ,openings:[opening]});
      }else{
        splitWall({floor,axis:'z',fixed:minX,from:minZ,to:maxZ,openings:[opening]});
        wallZ({floor,x:maxX,z:cz,depth:maxZ-minZ});
      }

      const fixed=room.front==='east'?maxX:minX;
      const openAngle=room.front==='east'?-HALF_TURN:HALF_TURN; // always swings INTO department
      const leaf=hingedLeaf({
        id:`door-${room.id}`,floor,fixed,center:room.entry,width,openAngle,
        extra:{
          roomNumber:room.id,
          locked:!!room.locked,
          requiredKey:keyIdForFloor(floor),
          openInitially:!room.locked
        }
      });
      roomDoors.push(leaf); swingDoors.push(leaf);
      doorFrame({floor,axis:'z',fixed,center:room.entry,width,material:'metal'});
      // A hunt/hide target is a clear aisle, not the geometric center of a bed.
      roomCenters.push({roomNumber:room.id,floor,
        x:clean(fixed+(room.front==='east'?-3.5:3.5)),z:room.entry,side:leaf.side,
        minX,maxX,minZ,maxZ});
      fixtures.push({
        kind:'room-fill',floor,roomNumber:room.id,doorId:leaf.id,
        x:clean(cx),y:clean(levelY(floor)+WALL_H-.12),localY:clean(WALL_H-.12),z:clean(cz),
        w:.72,h:.06,d:.42,spec:layout.getRoomFillLight(floor)
      });
      const outset=room.front==='east'?.16:-.16;
      signs.push({
        floor,text:room.name,x:clean(fixed+outset),y:clean(levelY(floor)+2.82),localY:2.82,z:room.entry,
        rotationY:room.front==='east'?HALF_TURN:-HALF_TURN,
        w:Math.min(6.8,Math.max(3.4,room.name.length*.31)),h:.72
      });
      pointLight({floor,x:cx,z:cz,intensity:.42,distance:10});
      doorClearance.push({
        room:room.id,floor,
        minX:room.front==='east'?fixed-3.2:fixed-.2,
        maxX:room.front==='east'?fixed+.2:fixed+3.2,
        minZ:room.entry-1.7,maxZ:room.entry+1.7
      });
    }

    // --- hospital-specific dressing -------------------------------------------------------------
    // Main lobby / admissions at the center south. Production desks/couches, with generous clear routes.
    place('desk',1,-2.7,-27,0,{lamp:true,label:'admissions desk'});
    place('desk',1,2.7,-27,0,{lamp:true,label:'admissions desk'});
    place('couch',1,-10,-27,0);
    place('couch',1,10,-27,Math.PI);
    place('plant',1,-5,-29.4,0,{scale:1.05});
    place('plant',1,5,-29.4,0,{scale:1.05});

    // Central nurses station on upper floor, offset from the actual intersection so the cross remains open.
    place('desk',2,-3,-1.8,0,{lamp:true,label:'nurses station'});
    place('desk',2,3,1.8,Math.PI,{lamp:true,label:'nurses station'});

    function roomBy(id){ return ROOMS.find(r=>r.id===id); }
    function inside(id,depth,lateral){
      const r=roomBy(id);
      return {
        floor:r.floor,
        x:r.front==='east'?r.maxX-depth:r.minX+depth,
        z:r.entry+lateral
      };
    }
    function inPlace(id,type,depth,lateral,rotationY=0,extra={}){
      const p=inside(id,depth,lateral); return place(type,p.floor,p.x,p.z,rotationY,extra);
    }

    // ER / recovery / wards: real production beds, deliberately never within the doorway clearance.
    for(const lat of [-8,-3,5,9]) inPlace('101','bed',6.5,lat,HALF_TURN);
    for(const lat of [-7,0,7]) inPlace('107','bed',7,lat,-HALF_TURN);
    for(const id of ['201','205']) for(const lat of [-8,-3,4,9]) inPlace(id,'bed',6.5,lat,HALF_TURN);
    for(const lat of [-7,0,7]) inPlace('204','bed',6.4,lat,-HALF_TURN);
    inPlace('203','bed',7,-5,-HALF_TURN); inPlace('203','bed',7,6,-HALF_TURN);

    // Cafeteria: thin table assemblies rather than monolithic blocks.
    for(const [x,z] of [[-15,-26],[-9,-26],[-15,-10],[-9,-10]]){
      prop({floor:1,x,z,w:2.4,h:.1,d:1.35,localY:.78,material:'wood',collider:false});
      hiddenCollider({floor:1,x,z,w:2.5,h:.9,d:1.45,localY:.45,id:`table-${x}-${z}`});
      for(const dx of [-1,1])for(const dz of [-.45,.45])
        prop({floor:1,x:x+dx,z:z+dz,w:.08,h:.76,d:.08,localY:.38,material:'dark',collider:false});
    }

    // Pharmacy / meds: production dressers on the far wall plus framed racks.
    for(const lat of [-9,-5,5,9]) inPlace('103','dresser',8.5,lat,HALF_TURN,{label:'medication cabinet'});
    for(const lat of [-8,-2,5,9]) inPlace('206','dresser',8.3,lat,HALF_TURN,{label:'medication cabinet'});

    // Each floor's master key. The pharmacy and isolation are the doors it opens, so the drawer that
    // holds it stands in a department that is open from the start: the laboratory downstairs and the
    // nurses' station above. A drawer holds one key, and whoever searches it second finds it empty.
    inPlace('105','dresser',10.9,-4,-HALF_TURN,{
      keyId:keyIdForFloor(1),keyLabel:keyLabelForFloor(1),label:'specimen cabinet'
    });
    inPlace('206','dresser',8.3,-5,HALF_TURN,{
      keyId:keyIdForFloor(2),keyLabel:keyLabelForFloor(2),label:'narcotics cabinet'
    });

    function rack(floor,x,z,w=4,d=.72,rotationY=0,id='rack'){
      const turned=Math.abs(Math.sin(rotationY))>.7;
      const rw=turned?d:w, rd=turned?w:d;
      hiddenCollider({floor,x,z,w:rw,h:2.05,d:rd,localY:1.025,id});
      const postOffsets=turned?[[0,-w/2],[0,w/2]]:[[-w/2,0],[w/2,0]];
      for(const [dx,dz] of postOffsets) prop({floor,x:x+dx,z:z+dz,w:.08,h:2.0,d:.08,localY:1,material:'metal',collider:false});
      for(const y of [.28,.72,1.16,1.6]){
        prop({floor,x,z,w:rw,h:.07,d:rd,localY:y,material:'metal',collider:false});
      }
    }
    rack(1,16.5,-27,5,.72,0,'pharmacy-rack-1');
    rack(1,16.5,-9,5,.72,0,'pharmacy-rack-2');
    rack(1,-36,28,6,.72,0,'lab-rack-1');
    rack(1,-36,8.5,6,.72,0,'lab-rack-2');

    // Imaging: a recognizable CT gantry + patient table.
    const ct={x:36,z:-24};
    prop({floor:1,x:ct.x-1.35,z:ct.z,w:.48,h:2.65,d:1.1,localY:1.325,material:'linen'});
    prop({floor:1,x:ct.x+1.35,z:ct.z,w:.48,h:2.65,d:1.1,localY:1.325,material:'linen'});
    prop({floor:1,x:ct.x,z:ct.z,w:3.18,h:.46,d:1.1,localY:2.42,material:'linen'});
    prop({floor:1,x:36,z:-13,w:1.05,h:.18,d:5.2,localY:.74,material:'linen'});
    hiddenCollider({floor:1,x:36,z:-13,w:1.15,h:.95,d:5.3,localY:.475,id:'ct-table'});

    // Surgery: two operating tables with narrow pedestal bases and clear circulation.
    for(const z of [10.5,27]){
      prop({floor:1,x:-13,z,w:2.05,h:.16,d:4.0,localY:.86,material:'linen'});
      prop({floor:1,x:-13,z,w:.58,h:.74,d:1.25,localY:.37,material:'metal'});
      hiddenCollider({floor:1,x:-13,z,w:2.1,h:1.0,d:4.05,localY:.5,id:`or-table-${z}`});
    }

    // Lab / administration workstations.
    for(const lat of [-8,0,8]) inPlace('105','desk',7.4,lat,HALF_TURN,{lamp:true});
    for(const lat of [-8,0,8]) inPlace('202','desk',7.2,lat,HALF_TURN,{lamp:true});

    // Rehab / chapel gets seating plus parallel bars.
    inPlace('207','couch',7.5,-7,0); inPlace('207','couch',7.5,7,Math.PI);
    for(const x of [9,15]){
      prop({floor:2,x,z:28,w:.08,h:.9,d:6.5,localY:.9,material:'metal',collider:false});
      prop({floor:2,x,z:28,w:.08,h:.08,d:6.5,localY:.9,material:'metal',collider:false});
    }

    // --- stair core -----------------------------------------------------------------------------
    const stairShell={bounds:{xWest:STAIR.xWest-.3,xEast:STAIR.xEast+.3,zMin:STAIR.zSouth-.3,zMax:STAIR.zNorth+.3}};
    const stairLayout={entrances:[],landings:[],flights:[]};
    for(const def of floorDefs){
      const y=levelY(def.id);
      stairLayout.entrances.push({floor:def.id,x:clean(STAIR.xWest-.9),z:STAIR.doorZ,y:clean(y)});
      stairLayout.landings.push({kind:'floor',floor:def.id,x:STAIR.landingX,z:STAIR.doorZ,y:clean(y),w:9.4,d:2.25});
      splitWall({floor:def.id,axis:'z',fixed:STAIR.xWest,from:STAIR.zSouth,to:STAIR.zNorth,
        openings:[{center:STAIR.doorZ,width:STAIR.doorWidth,height:2.4}],material:'dark'});
      doorFrame({floor:def.id,axis:'z',fixed:STAIR.xWest,center:STAIR.doorZ,width:STAIR.doorWidth,height:2.4,material:'brass'});
      signs.push({floor:def.id,text:'SERVICE STAIRS',x:STAIR.xWest-.14,y:clean(y+2.78),localY:2.78,z:STAIR.doorZ-1.8,rotationY:HALF_TURN,w:3.1,h:.55});
    }
    stairLayout.landings.push({kind:'switchback',transition:1,x:STAIR.landingX,z:18.15,y:clean(FLOOR_H/2),w:9.4,d:2.1});
    stairLayout.flights.push(
      {transition:1,lane:'west',startX:STAIR.westLane,startZ:11.3,endX:STAIR.westLane,endZ:17.25,startY:0,endY:clean(FLOOR_H/2),width:1.55,steps:16,railSide:-1},
      {transition:1,lane:'east',startX:STAIR.eastLane,startZ:17.25,endX:STAIR.eastLane,endZ:11.3,startY:clean(FLOOR_H/2),endY:clean(FLOOR_H),width:1.55,steps:16,railSide:1}
    );
    wallZ({floor:1,x:STAIR.xEast,z:(STAIR.zSouth+STAIR.zNorth)/2,depth:STAIR.zNorth-STAIR.zSouth,base:0,height:SHELL_H,material:'dark'});
    wallX({floor:1,x:STAIR.landingX,z:STAIR.zNorth,width:STAIR.xEast-STAIR.xWest,base:0,height:SHELL_H,material:'dark'});
    wallX({floor:1,x:STAIR.landingX,z:STAIR.zSouth,width:STAIR.xEast-STAIR.xWest,base:0,height:SHELL_H,material:'dark'});

    for(const landing of stairLayout.landings){
      stairs.treads.push({x:landing.x,y:clean(landing.y-.07),z:landing.z,w:landing.w,h:.14,d:landing.d,rotationY:0});
      surfaces.push({kind:'rect',floor:0,priority:2,minX:clean(landing.x-landing.w/2),maxX:clean(landing.x+landing.w/2),minZ:clean(landing.z-landing.d/2),maxZ:clean(landing.z+landing.d/2),y:clean(landing.y)});
    }
    for(const flight of stairLayout.flights){
      for(let i=0;i<flight.steps;i++){
        const t=(i+.5)/flight.steps;
        stairs.treads.push({
          x:flight.startX,
          y:clean(flight.startY+(flight.endY-flight.startY)*((i+1)/flight.steps)-.055),
          z:clean(flight.startZ+(flight.endZ-flight.startZ)*t),
          w:flight.width,h:.11,d:clean(Math.abs(flight.endZ-flight.startZ)/flight.steps+.035),rotationY:0
        });
      }
      surfaces.push({
        kind:'ramp',floor:0,priority:3,
        minX:clean(flight.startX-flight.width/2),maxX:clean(flight.startX+flight.width/2),
        minZ:clean(Math.min(flight.startZ,flight.endZ)),maxZ:clean(Math.max(flight.startZ,flight.endZ)),
        startZ:clean(flight.startZ),endZ:clean(flight.endZ),startY:clean(flight.startY),endY:clean(flight.endY)
      });
      const rx=flight.startX+flight.railSide*(flight.width/2+.045);
      stairs.rails.push({
        start:{x:clean(rx),y:clean(flight.startY+.86),z:clean(flight.startZ)},
        end:{x:clean(rx),y:clean(flight.endY+.86),z:clean(flight.endZ)}
      });
    }

    // --- elevator core --------------------------------------------------------------------------
    const shaftMinX=shaft.minX,shaftMaxX=shaft.maxX,shaftMaxZ=shaft.maxZ;
    wallZ({floor:1,x:shaftMinX,z:LIFT.centerZ,depth:LIFT.halfDepth*2,base:0,height:SHELL_H+.2,material:'dark'});
    wallZ({floor:1,x:shaftMaxX,z:LIFT.centerZ,depth:LIFT.halfDepth*2,base:0,height:SHELL_H+.2,material:'dark'});
    wallX({floor:1,x:LIFT.centerX,z:shaftMaxZ,width:LIFT.halfWidth*2,base:0,height:SHELL_H+.2,material:'dark'});
    for(const def of floorDefs){
      splitWall({floor:def.id,axis:'x',fixed:LIFT.frontZ,from:shaftMinX,to:shaftMaxX,
        openings:[{center:LIFT.centerX,width:2.1,height:2.4}],material:'dark'});
      doorFrame({floor:def.id,axis:'x',fixed:LIFT.frontZ,center:LIFT.centerX,width:2.1,height:2.4,material:'brass'});
      signs.push({floor:def.id,text:`FLOOR ${def.id}`,x:LIFT.centerX,y:clean(levelY(def.id)+2.78),localY:2.78,z:LIFT.frontZ-.13,rotationY:Math.PI,w:1.8,h:.48});
      for(const side of ['left','right']){
        const direction=side==='left'?-1:1;
        const leaf={
          id:`hall-door-${def.id}-${side}`,kind:'hall',floor:def.id,side,direction,
          centerX:LIFT.centerX,x:clean(LIFT.centerX+direction*.46),
          y:clean(levelY(def.id)+1.175),z:clean(LIFT.frontZ-.08),w:.92,h:2.35,d:.08
        };
        hallDoors.push(leaf); slidingDoors.push(leaf);
      }
      // Real interactive hall call button. This was missing from the failed hospital plan.
      box({floor:def.id,kind:'call-button',material:'brass',collider:false,
        x:clean(shaftMaxX+.42),localY:1.25,z:clean(LIFT.frontZ-.215),
        w:.11,h:.18,d:.04,callFloor:def.id,id:`elevator-call-${def.id}`});
    }
    surfaces.push({
      kind:'dynamic',id:'elevator-car',floor:0,priority:2,
      minX:clean(LIFT.centerX-1.16),maxX:clean(LIFT.centerX+1.16),
      minZ:clean(LIFT.frontZ-.12),maxZ:clean(LIFT.centerZ+1.47)
    });

    // --- practical lighting --------------------------------------------------------------------
    for(const def of floorDefs){
      for(const [x,z] of [
        [-25,-25],[-25,-8],[-25,8],[-25,25],
        [0,-25],[0,-8],[0,8],[0,25],
        [25,-25],[25,-8],[25,8],[25,25],
        [-12,0],[12,0],[35,23]
      ]){
        prop({floor:def.id,x,z,w:.7,h:.08,d:.28,localY:2.72,material:'redLight',collider:false});
        pointLight({floor:def.id,x,z,intensity:.5,distance:9});
      }
    }

    // --- navigation -----------------------------------------------------------------------------
    const nodes=[],edges=[];
    const corridorZ=[-27,-18,0,18,27];
    for(const def of floorDefs){
      for(const x of HALL_X){
        let prev=null;
        for(const z of corridorZ){
          const id=`hall-${def.id}-${x}-${z}`;
          nodes.push({id,floor:def.id,x,z});
          if(prev)edges.push([prev,id]);
          prev=id;
        }
      }
      // Main east/west hospital cross.
      edges.push([`hall-${def.id}--25-0`,`hall-${def.id}-0-0`]);
      edges.push([`hall-${def.id}-0-0`,`hall-${def.id}-25-0`]);
    }
    function approach(r){
      return r.front==='east'?{x:r.maxX+1.25,z:r.entry}:{x:r.minX-1.25,z:r.entry};
    }
    function nearestHall(floor,x,z){
      const hx=HALL_X.reduce((a,b)=>Math.abs(b-x)<Math.abs(a-x)?b:a,HALL_X[0]);
      const hz=corridorZ.reduce((a,b)=>Math.abs(b-z)<Math.abs(a-z)?b:a,corridorZ[0]);
      return `hall-${floor}-${hx}-${hz}`;
    }
    for(const r of ROOMS){
      const p=approach(r),id=`room-approach-${r.id}`;
      nodes.push({id,floor:r.floor,x:clean(p.x),z:clean(p.z)});
      edges.push([id,nearestHall(r.floor,p.x,p.z)]);
      const room=roomCenters.find(entry=>entry.roomNumber===r.id);
      const insideId=`room-aisle-${r.id}`;
      nodes.push({id:insideId,floor:r.floor,x:room.x,z:room.z});
      edges.push([id,insideId]);
    }
    for(const def of floorDefs){
      const stairNode=`stair-approach-${def.id}`;
      nodes.push({id:stairNode,floor:def.id,x:29.0,z:STAIR.doorZ});
      edges.push([stairNode,`hall-${def.id}-25-18`]);
      const liftNode=`lift-lobby-${def.id}`;
      nodes.push({id:liftNode,floor:def.id,x:31.2,z:24.8});
      edges.push([liftNode,`hall-${def.id}-25-27`]);
      // Leave the cabin straight through its doorway before turning into the service lobby.
      const liftExit=`lift-exit-${def.id}`;
      nodes.push({id:liftExit,floor:def.id,x:LIFT.centerX,z:24.4});
      edges.push([liftExit,liftNode]);
    }

    const navigation={
      nodes,edges,
      connectors:[{
        id:'service-stair',kind:'stair',floors:[1,2],
        approach:{x:29.0,z:STAIR.doorZ},
        layout:stairLayout,shell:stairShell
      }],
      spawnNodes:[
        {floor:1,x:-25,z:0},{floor:1,x:0,z:27},
        {floor:2,x:-25,z:-27},{floor:2,x:25,z:0},{floor:2,x:25,z:27}
      ],
      minSpawnSeparation:24
    };

    const spawns={
      // Production rounds hold the seeker in the cabin; the reference lobby remains an inspection view.
      seeker:{floor:1,x:LIFT.centerX,z:LIFT.centerZ-.25,y:0},
      hiders:[
        {floor:1,x:-25,z:-27,y:0},{floor:1,x:0,z:-18,y:0},{floor:1,x:25,z:-27,y:0},{floor:1,x:25,z:18,y:0},
        {floor:2,x:-25,z:27,y:clean(FLOOR_H)},{floor:2,x:0,z:-18,y:clean(FLOOR_H)},{floor:2,x:25,z:-27,y:clean(FLOOR_H)},{floor:2,x:-25,z:18,y:clean(FLOOR_H)}
      ]
    };

    const colliders=boxes.filter(e=>e.collider).map(e=>({...boxBounds(e),id:e.id||null,floor:e.floor}));

    return {
      elevator:{centerX:LIFT.centerX,centerZ:LIFT.centerZ,frontZ:LIFT.frontZ,halfWidth:LIFT.halfWidth,halfDepth:LIFT.halfDepth,floors:[1,2]},
      boxes,surfaces,colliders,swingDoors,slidingDoors,roomDoors,secretPanels,secretTunnels,
      roomCenters,furnishings,hallDoors,signs,doorFrames,wallLamps,lights,fixtures,stairs,spawns,navigation,
      inspectionViews:{
        lobby:{x:0,y:1.62,z:-27,yaw:Math.PI,pitch:0},
        emergency:{x:-33,y:1.62,z:-18,yaw:Math.PI/2,pitch:-.08},
        ward:{x:-33,y:clean(FLOOR_H+1.62),z:-18,yaw:Math.PI/2,pitch:-.08},
        stairs:{x:25,y:1.62,z:10.5,yaw:-Math.PI/2,pitch:0},
      },
      qa:{doorClearance}
    };
  }

  return {...geometry,FLOOR_DEFS,createHospitalPlan};
});
