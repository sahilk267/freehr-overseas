export interface GuaranteeStatus {
  placementId: string;
  guaranteeStartAt: Date | null;
  guaranteeEndAt: Date | null;
  durationDays: number;
  daysRemaining: number;
  status: "not_started" | "active" | "expired" | "replacement_requested" | "closed";
  isActive: boolean;
  isExpired: boolean;
}

export const DEFAULT_GUARANTEE_DAYS = 90;

export function calculateGuaranteeDates(
  joiningConfirmedAt: Date,
  durationDays = DEFAULT_GUARANTEE_DAYS,
): { guaranteeStartAt: Date; guaranteeEndAt: Date } {
  const guaranteeStartAt = new Date(joiningConfirmedAt.getTime());
  const guaranteeEndAt = new Date(
    guaranteeStartAt.getTime() + durationDays * 24 * 60 * 60 * 1000,
  );
  return { guaranteeStartAt, guaranteeEndAt };
}

export function computeGuaranteeStatus(
  placement: {
    id: string;
    status: string;
    guaranteeStartAt: Date | null;
    guaranteeEndAt: Date | null;
    joiningConfirmedAt?: Date | null;
  },
  now = new Date(),
): GuaranteeStatus {
  if (placement.status === "replacement_requested" || placement.status === "replacement_in_progress") {
    return {
      placementId: placement.id,
      guaranteeStartAt: placement.guaranteeStartAt,
      guaranteeEndAt: placement.guaranteeEndAt,
      durationDays: placement.guaranteeStartAt && placement.guaranteeEndAt
        ? Math.round((placement.guaranteeEndAt.getTime() - placement.guaranteeStartAt.getTime()) / (24 * 60 * 60 * 1000))
        : DEFAULT_GUARANTEE_DAYS,
      daysRemaining: 0,
      status: "replacement_requested",
      isActive: false,
      isExpired: false,
    };
  }

  if (placement.status === "closed" || placement.status === "replacement_closed") {
    return {
      placementId: placement.id,
      guaranteeStartAt: placement.guaranteeStartAt,
      guaranteeEndAt: placement.guaranteeEndAt,
      durationDays: placement.guaranteeStartAt && placement.guaranteeEndAt
        ? Math.round((placement.guaranteeEndAt.getTime() - placement.guaranteeStartAt.getTime()) / (24 * 60 * 60 * 1000))
        : DEFAULT_GUARANTEE_DAYS,
      daysRemaining: 0,
      status: "closed",
      isActive: false,
      isExpired: true,
    };
  }

  const start = placement.guaranteeStartAt || placement.joiningConfirmedAt || null;
  const end = placement.guaranteeEndAt || (start ? new Date(start.getTime() + DEFAULT_GUARANTEE_DAYS * 24 * 60 * 60 * 1000) : null);

  if (!start || !end) {
    return {
      placementId: placement.id,
      guaranteeStartAt: null,
      guaranteeEndAt: null,
      durationDays: DEFAULT_GUARANTEE_DAYS,
      daysRemaining: DEFAULT_GUARANTEE_DAYS,
      status: "not_started",
      isActive: false,
      isExpired: false,
    };
  }

  const durationDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
  const nowMs = now.getTime();
  const endMs = end.getTime();
  const startMs = start.getTime();

  if (nowMs < startMs) {
    return {
      placementId: placement.id,
      guaranteeStartAt: start,
      guaranteeEndAt: end,
      durationDays,
      daysRemaining: durationDays,
      status: "not_started",
      isActive: false,
      isExpired: false,
    };
  }

  if (nowMs >= endMs) {
    return {
      placementId: placement.id,
      guaranteeStartAt: start,
      guaranteeEndAt: end,
      durationDays,
      daysRemaining: 0,
      status: "expired",
      isActive: false,
      isExpired: true,
    };
  }

  const msRemaining = endMs - nowMs;
  const daysRemaining = Math.ceil(msRemaining / (24 * 60 * 60 * 1000));

  return {
    placementId: placement.id,
    guaranteeStartAt: start,
    guaranteeEndAt: end,
    durationDays,
    daysRemaining,
    status: "active",
    isActive: true,
    isExpired: false,
  };
}
