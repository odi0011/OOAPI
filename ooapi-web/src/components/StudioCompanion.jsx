import React, { useEffect, useRef, useState } from 'react';
import { PauseOutlined, CaretRightOutlined } from '@ant-design/icons';
const SCENES=[
 {pose:'wave',action:'hop',text:'喵！新的好点子，准备好了吗？'},
 {pose:'key',action:'sway',text:'你的密钥，我帮你看着。记得别分享给别人哦。'},
 {pose:'code',action:'bounce',text:'键盘就位，灵感开工。'},
 {pose:'nap',action:'breathe',text:'我眯一小会儿，你继续发光。'},
 {pose:'play',action:'roll',text:'伸个懒腰，下一步会更顺。'},
 {pose:'teach',action:'sway',text:'接入指南在上面。三步，就能开始。'},
 {pose:'friends',action:'hop',text:'带了个新朋友，一起陪你做东西。'},
];
export default function StudioCompanion({motion,preferredPose='wave'}) {
 const [scene,setScene]=useState({...SCENES[0],pose:preferredPose});const [speaking,setSpeaking]=useState(false);const [paused,setPaused]=useState(false);const [manual,setManual]=useState(false);
 const previous=useRef(-1),bubbleTimer=useRef(null),picture=useRef(null),cycle=useRef(0);
 const act=(isManual=false)=>{
  let index=Math.floor(Math.random()*SCENES.length);if(index===previous.current)index=(index+1)%SCENES.length;previous.current=index;
  setScene(SCENES[index]);setManual(isManual);setSpeaking(true);cycle.current+=1;clearTimeout(bubbleTimer.current);bubbleTimer.current=setTimeout(()=>setSpeaking(false),4600);
 };
 useEffect(()=>{setScene({...SCENES[0],pose:preferredPose});},[preferredPose]);
 useEffect(()=>{
  if(!motion.active||paused){setSpeaking(false);return;}
  let timer;const next=()=>{timer=setTimeout(()=>{act(false);next();},14000+Math.random()*14000);};next();
  return()=>clearTimeout(timer);
 },[motion.active,paused]);
 useEffect(()=>()=>clearTimeout(bubbleTimer.current),[]);
 useEffect(()=>{
  if(!motion.active||paused||!picture.current)return;
  const frames=scene.action==='roll'?[{rotate:'0deg'},{rotate:'-11deg',offset:.3},{rotate:'7deg',offset:.7},{rotate:'0deg'}]:scene.action==='sway'?[{rotate:'0deg'},{rotate:'-5deg',offset:.3},{rotate:'4deg',offset:.7},{rotate:'0deg'}]:scene.action==='breathe'?[{scale:'1'},{scale:'1.025 .98',offset:.5},{scale:'1'}]:[{transform:'translateY(0) scale(1)'},{transform:'translateY(4px) scale(1.06,.93)',offset:.16},{transform:'translateY(-17px) scale(.97,1.03)',offset:.4},{transform:'translateY(2px) scale(1.02,.98)',offset:.76},{transform:'translateY(0) scale(1)'}];
  const animation=picture.current.animate(frames,{duration:scene.action==='breathe'?2200:1000,easing:'cubic-bezier(.22,.75,.3,1)'});return()=>animation.cancel();
 },[scene,motion.active,paused]);
 return <aside className="studio-companion" aria-label="桌面小伙伴"><div className={`studio-companion-bubble${speaking?' is-speaking':''}`} aria-live={manual?'polite':'off'}>{speaking?scene.text:''}</div><button ref={picture} type="button" className={`studio-companion-pet action-${scene.action}`} aria-label="和小猫打个招呼" onClick={()=>act(true)}><img src={`/illustrations/cat-${scene.pose}.webp`} alt="" draggable="false"/><span className="studio-companion-shadow"/></button><button type="button" className="studio-companion-pause" aria-label={paused?'恢复小猫随机互动':'暂停小猫随机互动'} title={paused?'恢复小猫随机互动':'暂停小猫随机互动'} onClick={()=>setPaused(p=>!p)}>{paused?<CaretRightOutlined/>:<PauseOutlined/>}</button></aside>;
}
