import { Injectable } from '@nestjs/common';

/** Time source; tests substitute a fake to control expiry, deadlines and timeouts. */
export abstract class Clock {
  abstract now(): Date;

  nowMs(): number {
    return this.now().getTime();
  }
}

@Injectable()
export class SystemClock extends Clock {
  override now(): Date {
    return new Date();
  }
}

export class FakeClock extends Clock {
  constructor(private current: Date) {
    super();
  }

  override now(): Date {
    return new Date(this.current);
  }

  set(date: Date): void {
    this.current = date;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
