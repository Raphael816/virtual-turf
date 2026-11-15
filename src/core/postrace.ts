/**
 * レース後のコメント（第10段階）。
 *
 * シミュレーションが記録した要素（出遅れ・掛かり・ハナ争い・詰まり・外を回ったロス・ペースと位置取り・
 * 上がり・スタミナの残り・適性・調子・馬体重の増減）から、騎手の談話の形の短い文章を作る。
 * 文章は自動生成で、騎手・談話とも架空。内容は必ずそのレースの計算結果に基づく（結果と無関係な文は出さない）。
 */
import { type RaceCard, entryHorse } from './meeting';
import { GOING_INDEX, type SimResult } from './sim';

export interface PostComment {
  number: number;
  name: string;
  jockey: string;
  rank: number;
  text: string;
}

/** 文字列から決まった番号を作る（言い回しを選ぶため。結果には関係しない） */
function pickOf(key: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % n;
}

export function postRaceComments(card: RaceCard, res: SimResult): PostComment[] {
  const n = res.n;
  const D = card.conditions.distance;
  const going = GOING_INDEX[card.conditions.going];
  const avgLoss = res.factors.reduce((a, f) => a + f.laneLoss, 0) / n;
  const l3Order = Array.from({ length: n }, (_, i) => i).sort((a, b) => res.last3F[a] - res.last3F[b]);

  return res.order.map((i, k) => {
    const rank = k + 1;
    const e = card.entries[i];
    const h = entryHorse(e);
    const f = res.factors[i];
    const front = f.actualStyle === 'nige' || f.actualStyle === 'senko';
    const l3 = l3Order.indexOf(i) + 1;
    const good = rank <= 3;
    const pick = (xs: string[]) => xs[pickOf(`${card.id}:${e.number}:${xs[0]}`, xs.length)];
    const parts: string[] = [];

    // 不利・ロス（着順にかかわらず、あったことは述べる）
    if (f.lateStart) parts.push(good ? 'スタートで後手を踏みましたが、よく挽回してくれました' : pick(['スタートで後手を踏んだのが痛かったです', 'ゲートで遅れて、思った位置が取れませんでした']));
    if (f.kakari) parts.push(good ? '道中は少し力んでいましたが、最後までよく我慢してくれました' : pick(['道中で力んでしまい、最後は余力がありませんでした', '折り合いを欠いた分、終いが甘くなりました']));
    if (f.gaveUpLead) parts.push('ハナを主張しましたが、競られて息が入りませんでした');
    if (f.blockedTime > 2) parts.push(good ? '直線で前が壁になる場面がありましたが、開いてからはしっかり伸びました' : '直線で前が壁になり、追い出しが遅れました');
    if (f.laneLoss > avgLoss + 8) parts.push(good ? '外を回る形でも、よく走っています' : '終始外を回らされて、ロスが大きかったです');

    // 展開
    if (f.makuri) parts.push(good ? '流れが遅いと見て、早めに動いたのが良かったと思います' : '流れが遅いので早めに動きましたが、その分、最後は甘くなりました');
    else if (res.pace === 'high' && front && !good) parts.push('ペースが速く、前の馬には厳しい流れでした');
    else if (res.pace === 'slow' && !front && !good) parts.push('流れが落ち着いて、後ろからでは届きませんでした');
    else if (res.pace === 'slow' && front && good) parts.push('自分のペースで運べました');
    else if (res.pace === 'high' && !front && good) parts.push('前が速くなってくれて、展開も向きました');
    if (f.fought) parts.push(rank === 1 ? '並んでからもうひと伸びしてくれました' : good ? '最後まで食らいついています' : '最後は競り負けました');

    // 適性
    if (f.staminaEnd < 0.05 && D > h.bestDistance + 200 && !good) parts.push('距離が少し長いのかもしれません');
    else if (D < h.bestDistance - 300 && !good) parts.push('もう少し距離があった方が良さそうです');
    if (going >= 2) {
      if ((h.heavy === 'C' || h.heavy === 'D') && !good) parts.push('こういう馬場は合いません');
      else if (h.heavy === 'A' && good) parts.push('こういう馬場は得意です');
    }

    // 状態
    const bd = e.bodyDiff;
    if (bd !== undefined && bd >= 10 && !good) parts.push(`体に少し余裕がありました（馬体重 +${bd}kg）`);
    else if (bd !== undefined && bd <= -10 && !good) parts.push(`体が減っていたのも響いたかもしれません（馬体重 −${-bd}kg）`);
    else if (f.condition > 0.25 && good) parts.push('状態はとても良かったです');
    else if (f.condition < -0.2 && !good) parts.push('本来の出来にはもうひとつでした');

    // 脚
    if (l3 === 1 && rank > 1) parts.push('最後はメンバーで一番の脚を使っています');
    else if (l3 === 1) parts.push('追ってからの反応が素晴らしかったです');

    // 勝ち馬は、勝ち方をひとこと添える
    if (rank === 1 && parts.length < 2) {
      parts.unshift(
        f.posAtLastCorner <= 2
          ? pick(['手応え良く直線に向けて、しっかり押し切ってくれました', '早めに前をつかまえる形で、最後まで止まりませんでした'])
          : pick(['直線でよく伸びて、差し切ってくれました', 'じっくり運んで、最後にいい脚を使ってくれました']),
      );
    }
    let body = parts.slice(0, 2).join('。');
    if (!body) {
      body =
        rank === 1
          ? pick(['手応え良く直線に向けて、しっかり抜け出してくれました', 'スムーズに運べて、力を出し切ってくれました'])
          : good
            ? pick(['よく頑張っています。勝った馬が強かったです', '自分の競馬はできました。あと一歩でした'])
            : rank <= Math.ceil(n / 2)
              ? pick(['大きな不利はなく、力は出しています', 'じりじりとは伸びていますが、前も止まりませんでした'])
              : pick(['今日は直線で反応がありませんでした', '流れに乗れず、力を出し切れませんでした']);
    }
    return { number: e.number, name: h.name, jockey: e.jockey, rank, text: `${body}。` };
  });
}
