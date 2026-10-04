import assert from 'node:assert/strict'
import { revealNodeTranslation as reveal } from '../../frontend/src/canvas/revealNode.ts'
const canvas = { width: 600, height: 400 }
assert.deepEqual(reveal({x:100,y:100,width:240,height:120},canvas),{x:0,y:0})
assert.deepEqual(reveal({x:500,y:100,width:240,height:120},canvas),{x:-164,y:0})
assert.deepEqual(reveal({x:-20,y:100,width:240,height:120},canvas),{x:44,y:0})
assert.deepEqual(reveal({x:100,y:350,width:240,height:120},canvas),{x:0,y:-94})
assert.deepEqual(reveal({x:100,y:-10,width:240,height:120},canvas),{x:0,y:34})
const large = {x:80,y:90,width:700,height:500}
const translated = reveal(large,canvas)
assert.deepEqual(translated,{x:-56,y:-66})
assert.deepEqual(reveal({...large,x:large.x+translated.x,y:large.y+translated.y},canvas),{x:0,y:0})
assert.deepEqual(reveal({x:24,y:24,width:552,height:352},canvas),{x:0,y:0})
assert.deepEqual(reveal({x:20,y:20,width:100,height:100},{width:40,height:40}),{x:-10,y:-10})
// Minimap occupies bottom 84px plus 24px gap; selected node must clear that area.
const mapSafe = {width:408,height:560-84-24}
assert.deepEqual(reveal({x:154,y:406,width:230,height:122},mapSafe),{x:0,y:-100})
assert.deepEqual(reveal({x:154,y:306,width:230,height:122},mapSafe),{x:0,y:0})
// Without a map the same bounds remain visible in the full canvas.
assert.deepEqual(reveal({x:154,y:406,width:230,height:122},{width:408,height:560}),{x:0,y:0})
console.log('Selected node reveal: 12 geometry cases PASS')
