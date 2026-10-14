import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/core/analysis';
import { buildCommentary } from '../src/core/commentary';
import { type RaceCard, createMeeting, runRace } from '../src/core/meeting';
import { marginText } from '../src/core/sim';
import { HORSE_BY_ID } from '../src/data/roster';

let cards: RaceCard[];
beforeAll(async () => {
  let i = 0;
  cards = await createMeeting('analysis-test', () => `seed${i++}`);
});

const nameOf = (card: RaceCard, idx: number) => HORSE_BY_ID.get(card.entries[idx].horseId)!.name;

describe('レース後の振り返り解説', () => {
  it('見出しに勝ち馬とペースが含まれ、要点は1〜5件', () => {
    for (const card of cards) {
      const res = runRace(card, card.seed);
      const a = analyzeRace(card, res);
      expect(a.headline).toContain(nameOf(card, res.order[0]));
      expect(a.points.length).toBeGreaterThanOrEqual(1);
      expect(a.points.length).toBeLessThanOrEqual(5);
      expect(a.rows).toHaveLength(card.entries.length);
      expect(a.rows.map((r) => r.rank)).toEqual(card.entries.map((_, i) => i + 1));
    }
  });

  it('1番人気が負けた場合だけ敗因を述べる', () => {
    const card = cards[0];
    const res = runRace(card, card.seed);
    const winnerNo = card.entries[res.order[0]].number;
    const loserIdx = res.order[2];
    expect(analyzeRace(card, res, winnerNo).favoriteNote).toBeNull();
    const note = analyzeRace(card, res, card.entries[loserIdx].number).favoriteNote!;
    expect(note).toContain(nameOf(card, loserIdx));
    expect(note).toContain('3着');
  });

  it('勝利を保証したり、投票を勧めたりする表現を含まない', () => {
    const banned = ['必勝', '確実', '絶対', 'チャンス', '買い', '狙い目', '儲'];
    for (const card of cards) {
      const res = runRace(card, card.seed);
      const a = analyzeRace(card, res, card.entries[res.order[1]].number);
      const text = [a.headline, ...a.points, a.favoriteNote ?? ''].join('');
      for (const w of banned) expect(text).not.toContain(w);
    }
  });
});

describe('実況', () => {
  it('時刻順で、スタートと1着のゴールを含み、同じレースなら毎回同じ', () => {
    const card = cards[3];
    const res = runRace(card, card.seed);
    const a = buildCommentary(card, res);
    const b = buildCommentary(card, runRace(card, card.seed));
    expect(a).toEqual(b);
    expect(a[0].kind).toBe('start');
    for (let i = 1; i < a.length; i++) expect(a[i].t).toBeGreaterThanOrEqual(a[i - 1].t);
    const finish = a.find((l) => l.kind === 'finish')!;
    expect(finish.text).toContain(nameOf(card, res.order[0]));
  });

  it('先頭交代の実況は12秒以上の間隔をあける', () => {
    for (const card of cards) {
      const lines = buildCommentary(card, runRace(card, card.seed)).filter((l) => /先頭(が替わって|に立ちました)/.test(l.text));
      for (let i = 1; i < lines.length; i++) expect(lines[i].t - lines[i - 1].t).toBeGreaterThanOrEqual(12);
    }
  });

  it('着差の読み', () => {
    expect(marginText('クビ')).toBe('クビ');
    expect(marginText('1 1/4')).toBe('1 1/4馬身');
    expect(marginText('大差')).toBe('大差');
  });
});
