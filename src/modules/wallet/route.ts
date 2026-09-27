import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler";
import { requireFirebaseUser } from "../../shared/firebase.middleware";
import { getMyWallet, listTransactions, redeemFromWallet, topupWallet } from "./wallet";

const router = Router();

/** GET /api/wallet/me — creates the wallet on first access. */
router.get(
  "/me",
  requireFirebaseUser,
  asyncHandler(async (req, res) => getMyWallet(req.firebaseUid, res))
);

/** POST /api/wallet/me/topup — credit a balance. */
router.post(
  "/me/topup",
  requireFirebaseUser,
  asyncHandler(async (req, res) =>
    topupWallet(req.firebaseUid, req.body as Record<string, unknown>, res)
  )
);

/** POST /api/wallet/me/redeem — debit a balance. */
router.post(
  "/me/redeem",
  requireFirebaseUser,
  asyncHandler(async (req, res) =>
    redeemFromWallet(req.firebaseUid, req.body as Record<string, unknown>, res)
  )
);

/** GET /api/wallet/me/transactions — ledger, newest first. */
router.get(
  "/me/transactions",
  requireFirebaseUser,
  asyncHandler(async (req, res) =>
    listTransactions(req.firebaseUid, req.query as Record<string, unknown>, res)
  )
);

export default router;
