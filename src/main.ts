import { COURSES } from './core/track';
import { HORSES, TRACK_NAME } from './data/roster';

// Step 1: 雛形。画面は Step 4 で実装する
const app = document.getElementById('app');
if (app) {
  app.innerHTML = `
    <main style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 16px;line-height:1.7">
      <h1>Virtual Turf <small>(scaffold)</small></h1>
      <p>${TRACK_NAME}・登録馬 ${HORSES.length} 頭・芝1周 ${Math.round(COURSES.turf.circumference)}m</p>
      <p>デモコイン専用の試作です。画面は今後のステップで実装します。</p>
    </main>`;
}
