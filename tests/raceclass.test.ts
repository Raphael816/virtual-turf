import { describe, expect, it } from 'vitest';
import {
  ageWeight,
  allowanceExtra,
  basePrize,
  classEligible,
  classOfEarnings,
  earningsAdd,
  handicapRating,
  handicapWeights,
  prizeFor,
  termsLabel,
  weightEffect,
  wfaWeight,
} from '../src/core/raceclass';
import { STAKES, SLOTS, altsFor, stakesOfWeek } from '../src/core/program';
import { createMeeting, entryHorse, runRace } from '../src/core/meeting';
import { resultForWorld } from '../src/core/raceflow';
import { simulateRace, type RaceConditions } from '../src/core/sim';
import { type World, addWeeks, advanceWeek, ageOf, createWorld, recordRace, upgradeWorld } from '../src/core/world';
import { type Horse, HORSES } from '../src/data/roster';
import { ageEligible } from '../src/core/raceclass';

describe('クラスと収得賞金（JRA）', () => {
  it('収得賞金でクラスが決まる：1勝 500万以下／2勝 1000万以下／3勝 1600万以下／それを超えるとオープン', () => {
    expect(classOfEarnings(0)).toBe('maiden');
    expect(classOfEarnings(400)).toBe('win1');
    expect(classOfEarnings(500)).toBe('win1');
    expect(classOfEarnings(501)).toBe('win2');
    expect(classOfEarnings(1000)).toBe('win2');
    expect(classOfEarnings(1001)).toBe('win3');
    expect(classOfEarnings(1600)).toBe('win3');
    expect(classOfEarnings(1601)).toBe('open');
  });
  it('1つ勝つごとに上のクラスへ上がる（新馬・未勝利 400万、1勝 500万、2勝 600万、3勝 900万）', () => {
    let e = 0;
    const steps: string[] = [];
    for (const cls of ['maiden', 'win1', 'win2', 'win3'] as const) {
      e += earningsAdd({ cls, age: '3up', prize: 1000 }, 1);
      steps.push(classOfEarnings(e));
    }
    expect(steps).toEqual(['win1', 'win2', 'win3', 'open']);
    // 2着以下は加算なし（重賞以外）
    expect(earningsAdd({ cls: 'win2', age: '3up', prize: 1580 }, 2)).toBe(0);
  });
  it('重賞は1・2着が本賞金の半額、2歳GIIIは 1600万／600万、オープン特別・リステッドは年齢で決まった額', () => {
    expect(earningsAdd({ cls: 'g1', age: '3up', prize: 20000 }, 1)).toBe(10000);
    expect(earningsAdd({ cls: 'g1', age: '3up', prize: 20000 }, 2)).toBe(4000);
    expect(earningsAdd({ cls: 'g1', age: '3up', prize: 20000 }, 3)).toBe(0);
    expect(earningsAdd({ cls: 'g3', age: '2', prize: 3300 }, 1)).toBe(1600);
    expect(earningsAdd({ cls: 'g3', age: '2', prize: 3300 }, 2)).toBe(600);
    expect(earningsAdd({ cls: 'open', age: '2', prize: 1700 }, 1)).toBe(600);
    expect(earningsAdd({ cls: 'listed', age: '3', prize: 2100 }, 1)).toBe(1200);
    expect(earningsAdd({ cls: 'listed', age: '3up', prize: 2800 }, 1)).toBe(1400);
  });
  it('本賞金：2〜5着は1着の 40%・25%・15%・10%、6着以下はなし', () => {
    expect([1, 2, 3, 4, 5, 6].map((r) => prizeFor(1000, r))).toEqual([1000, 400, 250, 150, 100, 0]);
    // JRA の第1着本賞の表
    expect(basePrize('win3', '3up', true, 10, 'turf', 2000)).toBe(1870);
    expect(basePrize('maiden', '3', false, 3, 'dirt', 1200)).toBe(590);
    expect(basePrize('maiden', '3', false, 8, 'dirt', 1200)).toBe(580);
    expect(basePrize('newcomer', '2', false, 7, 'turf', 1600)).toBe(780);
  });
  it('出走できる条件：新馬は未出走だけ、未勝利は未勝利馬だけ、条件戦は格上挑戦はできるが格下には出られない', () => {
    expect(classEligible('newcomer', { earnings: 0, starts: 0 })).toBe(true);
    expect(classEligible('newcomer', { earnings: 0, starts: 1 })).toBe(false);
    expect(classEligible('maiden', { earnings: 0, starts: 3 })).toBe(true);
    expect(classEligible('maiden', { earnings: 400, starts: 3 })).toBe(false);
    expect(classEligible('win2', { earnings: 400, starts: 3 })).toBe(true);
    expect(classEligible('win2', { earnings: 1500, starts: 9 })).toBe(false);
    expect(classEligible('g1', { earnings: 400, starts: 3 })).toBe(true);
    expect(ageEligible('3up', 2)).toBe(false);
    expect(ageEligible('4up', 3)).toBe(false);
    expect(ageEligible('2', 2)).toBe(true);
  });
  it('条件の表記', () => {
    expect(termsLabel({ cls: 'win2', age: '3up' })).toBe('3歳以上2勝クラス');
    expect(termsLabel({ cls: 'newcomer', age: '2' })).toBe('2歳新馬');
    expect(termsLabel({ cls: 'g1', age: '3', filly: true })).toBe('3歳オープン(GI)（牝）');
  });
});

describe('負担重量（JRA）', () => {
  it('馬齢重量：2歳 9月まで 55／55、10〜12月 56／55、3歳 57／55', () => {
    expect([ageWeight(2, '牡', 9), ageWeight(2, '牝', 9)]).toEqual([55, 55]);
    expect([ageWeight(2, '牡', 10), ageWeight(2, '牝', 10)]).toEqual([56, 55]);
    expect([ageWeight(3, '牡', 4), ageWeight(3, 'セ', 4), ageWeight(3, '牝', 4)]).toEqual([57, 57, 55]);
  });
  it('異なる年齢の馬が走るレース：5歳以上 58kg（牝56）から3歳・4歳を月別・距離別に減量', () => {
    expect(wfaWeight(5, '牡', 6, 2000, true)).toBe(58);
    expect(wfaWeight(5, '牝', 6, 2000, true)).toBe(56);
    // 3歳 7月 1,400m 未満：3kg 減
    expect(wfaWeight(3, '牡', 7, 1200, true)).toBe(55);
    // 3歳 1月 2,200m 以上：オープン 10kg、オープン以外 9kg 減
    expect(wfaWeight(3, '牡', 1, 2500, true)).toBe(48);
    expect(wfaWeight(3, '牡', 1, 2500, false)).toBe(49);
    // 3歳 12月 1,600m：1kg 減
    expect(wfaWeight(3, '牡', 12, 1600, true)).toBe(57);
    // 4歳：2,200m 以上は 1〜3月に 1kg 減、1,400m 未満は減量なし
    expect(wfaWeight(4, '牡', 3, 2200, true)).toBe(57);
    expect(wfaWeight(4, '牡', 4, 2200, true)).toBe(58);
    expect(wfaWeight(4, '牡', 1, 1200, true)).toBe(58);
  });
  it('別定：重賞の勝ち・収得賞金で加算（上限 +2kg）', () => {
    expect(allowanceExtra('g2', { earnings: 9000, g1Wins: 1, g2Wins: 0, g3Wins: 0 })).toBe(2);
    expect(allowanceExtra('g2', { earnings: 9000, g1Wins: 0, g2Wins: 1, g3Wins: 0 })).toBe(1);
    expect(allowanceExtra('g2', { earnings: 9000, g1Wins: 0, g2Wins: 0, g3Wins: 2 })).toBe(0);
    expect(allowanceExtra('g3', { earnings: 9000, g1Wins: 0, g2Wins: 0, g3Wins: 1 })).toBe(1);
    expect(allowanceExtra('open', { earnings: 1800, g1Wins: 0, g2Wins: 0, g3Wins: 0 })).toBe(0);
    expect(allowanceExtra('open', { earnings: 3600, g1Wins: 0, g2Wins: 0, g3Wins: 0 })).toBe(1);
    expect(allowanceExtra('open', { earnings: 20000, g1Wins: 0, g2Wins: 0, g3Wins: 0 })).toBe(2);
  });
  it('ハンデ：評価が中央値の馬が55kg、評価の差1につき1kg（49〜60kg）', () => {
    // 中央値（6頭なら小さい側の真ん中＝10）の馬が 55kg
    expect(handicapWeights([10, 12, 13, 9, 30, -10])).toEqual([55, 57, 58, 54, 60, 49]);
    // 評価：上のクラスで僅差に走った馬ほど高い（1秒 ≒ 6馬身）
    const strong = handicapRating([{ k: 'win3', rk: 2, tb: 0.1, kg: 57 }], 1500);
    const weak = handicapRating([{ k: 'win3', rk: 9, tb: 1.2, kg: 55 }], 1500);
    expect(strong).toBeGreaterThan(weak + 5);
    // 評価できる走がなければクラスの基準値
    expect(handicapRating([], 1500)).toBe(9);
  });
});

/** 平均的な能力の馬（追加の能力・適性は外す） */
function plain(id: string): Horse {
  const { sustain: _a, control: _b, health: _c, growth: _d, growthType: _e, apt: _f, ...rest } = HORSES[0];
  return { ...rest, id, name: id, speed: 75, stamina: 75, accel: 75, start: 70, temper: 75, power: 70, style: 'senko', bestDistance: 2000, turf: 'B', dirt: 'B', heavy: 'B' };
}

describe('負担重量の影響', () => {
  it('重いほど遅く、軽いほど速い（1kg ≒ 1馬身の目安）', () => {
    expect(weightEffect(58, 2000).speed).toBeLessThan(1);
    expect(weightEffect(54, 2000).speed).toBeGreaterThan(1);
    expect(weightEffect(undefined, 2000)).toEqual({ speed: 1, stamina: 1 });
    // 同じ能力の10頭で、1頭だけ 6kg 重い／軽い：重い馬は勝ちにくく、軽い馬は勝ちやすい
    const cond: RaceConditions = { surface: 'turf', distance: 2000, weather: 'sunny', going: 'good', timeOfDay: 'day' };
    const rate = (kg: number) => {
      const runners = Array.from({ length: 10 }, (_, i) => ({ horse: plain(`h${i}`), number: i + 1, weight: i === 0 ? kg : 56 }));
      let w = 0;
      for (let s = 0; s < 200; s++) if (simulateRace(cond, runners, `kg${s}`, { record: false }).order[0] === 0) w++;
      return w / 200;
    };
    const heavy = rate(62);
    const light = rate(50);
    expect(heavy).toBeLessThan(0.1);
    expect(light).toBeGreaterThan(0.1);
    expect(light).toBeGreaterThan(heavy * 2);
  });
});

describe('番組と出馬表', () => {
  it('重賞の日程：架空の名前で、週が重ならない', () => {
    const weeks = STAKES.map((s) => s.week);
    expect(new Set(weeks).size).toBe(weeks.length);
    expect(STAKES.filter((s) => s.cls === 'g1').length).toBeGreaterThanOrEqual(10);
    expect(stakesOfWeek(51)?.name).toBe('翠ヶ原記念');
    // 春は 3歳／4歳以上、それ以後は 2歳／3歳以上
    for (const slot of SLOTS) {
      expect(altsFor(slot, 5).every((a) => a.age === '3' || a.age === '4up')).toBe(true);
      expect(altsFor(slot, 40).every((a) => a.age === '2' || a.age === '3' || a.age === '3up')).toBe(true);
    }
  });

  it('競馬界の開催：出走馬はすべて年齢・クラス・性別の条件を満たし、負担重量が付く', async () => {
    let w: World = createWorld();
    for (let i = 0; i < 30; i++) w = advanceWeek(w); // 第31週（2歳戦がある時期）
    const cards = await createMeeting('RC1', () => 's', w);
    expect(cards.length).toBeGreaterThanOrEqual(6);
    const ages = new Set<string>();
    for (const c of cards) {
      expect(c.terms).toBeDefined();
      const t = c.terms!;
      ages.add(t.age);
      expect(c.entries.length).toBeGreaterThanOrEqual(6);
      for (const e of c.entries) {
        const h = w.horses.find((x) => x.id === e.horseId)!;
        expect(ageEligible(t.age, ageOf(h, w.date))).toBe(true);
        expect(classEligible(t.cls, { earnings: h.earnings, starts: h.career.starts })).toBe(true);
        if (t.filly) expect(h.sex).toBe('牝');
        expect(e.weight).toBeGreaterThanOrEqual(49);
        expect(e.weight).toBeLessThanOrEqual(60);
        if (t.rule === 'age') expect(e.weight).toBe(ageWeight(ageOf(h, w.date), h.sex, 7));
        expect(entryHorse(e).id).toBe(h.id);
      }
    }
    expect(ages.has('2')).toBe(true);
    expect(ages.has('3up')).toBe(true);
    // 同じ開催日に2度は出走しない
    const ids = cards.flatMap((c) => c.entries.map((e) => e.horseId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('重賞の週は8Rが重賞になり、収得賞金の多い馬が集まる', async () => {
    let w: World = createWorld();
    while (w.date.week !== 19) w = advanceWeek(w);
    const cards = await createMeeting('RC2', () => 's', w);
    const main = cards.find((c) => c.name === '薫風カップ')!;
    expect(main.terms!.cls).toBe('g1');
    expect(main.terms!.prize).toBe(18000);
    const avg = (ids: string[]) => ids.reduce((a, id) => a + w.horses.find((h) => h.id === id)!.earnings, 0) / ids.length;
    const others = cards.filter((c) => c !== main && c.terms!.age === '4up').flatMap((c) => c.entries.map((e) => e.horseId));
    expect(avg(main.entries.map((e) => e.horseId))).toBeGreaterThan(avg(others) * 2);
  });

  it('確定すると、勝ち馬は収得賞金が加算されてクラスが上がり、1〜5着に本賞金が入る', async () => {
    let w: World = createWorld();
    w = advanceWeek(w);
    const cards = await createMeeting('RC3', () => 's', w);
    const card = cards.find((c) => c.terms!.cls === 'maiden')!;
    const res = runRace(card, 's', { record: false });
    const winnerId = card.entries[res.order[0]].horseId;
    const second = card.entries[res.order[1]].horseId;
    const before = w.horses.find((h) => h.id === winnerId)!;
    expect(before.earnings).toBe(0);
    w = recordRace(w, resultForWorld(card, res));
    const after = w.horses.find((h) => h.id === winnerId)!;
    expect(after.earnings).toBe(400);
    expect(classOfEarnings(after.earnings)).toBe('win1');
    expect(after.career.prize).toBe((before.career.prize ?? 0) + card.terms!.prize);
    expect(after.history[0]).toMatchObject({ k: 'maiden', kg: card.entries[res.order[0]].weight, tb: 0, pz: card.terms!.prize });
    const sec = w.horses.find((h) => h.id === second)!;
    expect(sec.earnings).toBe(0);
    expect(sec.history[0].pz).toBe(Math.round(card.terms!.prize * 0.4));
    expect(sec.history[0].tb).toBeGreaterThanOrEqual(0);
  });

  it('初期の競馬界：各世代がクラスに分かれている（4歳以上はオープン〜1勝、3歳の多くは未勝利）', () => {
    const w = createWorld();
    const act = w.horses.filter((h) => h.status === 'active');
    const share = (age: (a: number) => boolean, cls: string) => {
      const g = act.filter((h) => age(ageOf(h, w.date)));
      return g.filter((h) => classOfEarnings(h.earnings) === cls).length / g.length;
    };
    expect(share((a) => a >= 4, 'open')).toBeGreaterThan(0.15);
    expect(share((a) => a >= 4, 'maiden')).toBeLessThan(0.1);
    expect(share((a) => a === 3, 'maiden')).toBeGreaterThan(0.5);
    expect(share((a) => a === 2, 'maiden')).toBe(1);
    // 戦績はクラスに見合う（勝ち星がある）
    expect(act.filter((h) => h.earnings > 0).every((h) => h.career.wins >= 1)).toBe(true);
  });

  it('古い保存データ（schema 2）を移行：収得賞金が付き、これまでの戦績は残る', () => {
    const w = createWorld();
    const old = {
      ...w,
      schema: 2,
      horses: w.horses.map(({ earnings: _e, ...h }, i) => ({ ...h, career: { starts: 5, wins: i % 3, seconds: 1, thirds: 0 } })),
    };
    const up = upgradeWorld(old as unknown as World);
    expect(up.schema).toBe(4);
    expect(up.horses.every((h) => typeof h.earnings === 'number' && h.career.starts === 5)).toBe(true);
    // 2勝している馬は少なくとも 2勝クラス
    const two = up.horses.find((_h, i) => i % 3 === 2)!;
    expect(two.earnings).toBeGreaterThanOrEqual(900);
  });

  it('3歳未勝利戦が終わると、未勝利の3歳馬の多くは引退・転出する', () => {
    let w: World = createWorld();
    while (w.date.week !== 37) w = advanceWeek(w);
    const maidens = w.horses.filter((h) => h.status === 'active' && h.earnings === 0 && ageOf(h, w.date) === 3).map((h) => h.id);
    w = advanceWeek(w);
    expect(addWeeks(w.date, 0).week).toBe(38);
    const gone = maidens.filter((id) => w.horses.find((h) => h.id === id)?.status !== 'active').length;
    expect(gone / maidens.length).toBeGreaterThan(0.5);
    expect(gone / maidens.length).toBeLessThan(0.9);
  });
});
