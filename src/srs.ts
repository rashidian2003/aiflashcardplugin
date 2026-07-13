import { CardSchedule, todayISO } from "./types";

/** Review ratings, matching Anki's 4-button convention. */
export enum Rating {
	Again = 0,
	Hard = 1,
	Good = 2,
	Easy = 3,
}

export const MIN_EASE = 1.3;

export function newSchedule(): CardSchedule {
	return { ease: 2.5, interval: 0, due: todayISO(), reps: 0, lapses: 0 };
}

export function isDue(schedule: CardSchedule | undefined): boolean {
	if (!schedule) return true; // new card
	return schedule.due <= todayISO();
}

function addDays(days: number): string {
	const d = new Date();
	d.setDate(d.getDate() + Math.max(0, Math.round(days)));
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
		d.getDate()
	).padStart(2, "0")}`;
}

/**
 * SM-2 scheduling (Anki-flavoured):
 * - Again: lapse — reps reset, ease penalty, card is due again today.
 * - Hard: small interval growth, ease penalty.
 * - Good: 1d → 6d → interval × ease.
 * - Easy: interval × ease × bonus, ease reward.
 */
export function schedule(prev: CardSchedule | undefined, rating: Rating): CardSchedule {
	const s: CardSchedule = prev ? { ...prev } : newSchedule();

	switch (rating) {
		case Rating.Again:
			s.lapses += 1;
			s.reps = 0;
			s.interval = 0;
			s.ease = Math.max(MIN_EASE, s.ease - 0.2);
			s.due = todayISO();
			return s;
		case Rating.Hard:
			s.ease = Math.max(MIN_EASE, s.ease - 0.15);
			s.interval = s.reps === 0 ? 1 : Math.max(s.interval + 1, Math.round(s.interval * 1.2));
			break;
		case Rating.Good:
			if (s.reps === 0) s.interval = 1;
			else if (s.reps === 1) s.interval = 6;
			else s.interval = Math.round(s.interval * s.ease);
			break;
		case Rating.Easy:
			s.ease += 0.15;
			if (s.reps === 0) s.interval = 2;
			else if (s.reps === 1) s.interval = 8;
			else s.interval = Math.round(s.interval * s.ease * 1.3);
			break;
	}
	s.reps += 1;
	s.interval = Math.min(s.interval, 3650); // cap at ~10 years
	s.due = addDays(s.interval);
	return s;
}
