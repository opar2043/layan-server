import bcrypt from "bcryptjs";

const SALT_ROUNDS = 10;

/** Hashes a plaintext password with bcrypt. Never store the plaintext. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

/** Constant-time comparison of a candidate password against a stored hash. */
export async function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export default { hashPassword, comparePassword };
