import { ApiError } from "../shared/errors";
import type { BookingStatus } from "../types/enums";
import { BookingStatus as Status } from "../types/enums";

/**
 * One state machine, used by the staff app and by customer-initiated cancellation
 * alike. Transitions are validated server-side regardless of who the caller is.
 */
const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  [Status.PENDING]: [Status.CONFIRMED, Status.CANCELLED, Status.LATE_CANCEL],
  [Status.CONFIRMED]: [
    Status.ATTENDED,
    Status.LATE_CANCEL,
    Status.NO_SHOW,
    Status.CANCELLED,
  ],
  [Status.ATTENDED]: [],
  [Status.LATE_CANCEL]: [],
  [Status.NO_SHOW]: [Status.ATTENDED],
  [Status.CANCELLED]: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from]?.includes(to) === true;
}

export function allowedTransitions(from: BookingStatus): readonly BookingStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (from === to) {
    throw ApiError.unprocessable(`Booking is already "${to}"`);
  }
  if (!canTransition(from, to)) {
    throw ApiError.unprocessable(
      `Cannot move a booking from "${from}" to "${to}"`,
      { from, to, allowed: allowedTransitions(from) },
    );
  }
}

/** Statuses that release the staff member's calendar slot. */
export function releasesSlot(status: BookingStatus): boolean {
  return (
    status === Status.CANCELLED ||
    status === Status.LATE_CANCEL ||
    status === Status.NO_SHOW
  );
}
