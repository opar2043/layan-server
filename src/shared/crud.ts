import type { Request, Response } from "express";
import { getCollection } from "./db";
import { generateId, isoNow } from "./utils";
import { sendError, sendSuccess } from "./response";

export type CrudHandler = (req: Request, res: Response) => Promise<Response | void>;

export interface CrudHandlers {
  findAll: CrudHandler;
  findById: CrudHandler;
  create: CrudHandler;
  update: CrudHandler;
  remove: CrudHandler;
}

export function createCrudHandlers(collectionName: string): CrudHandlers {
  const collection = () => getCollection(collectionName);

  const findAll: CrudHandler = async (_req, res) => {
    const docs = await collection().find({}).toArray();
    return sendSuccess(res, docs);
  };

  const findById: CrudHandler = async (req, res) => {
    const id = req.params.id;
    if (!id) return sendError(res, 400, "Missing id");
    const doc = await collection().findOne({ _id: id });
    if (!doc) return sendError(res, 404, `${collectionName} not found`);
    return sendSuccess(res, doc);
  };

  const create: CrudHandler = async (req, res) => {
    const _id = req.body._id ?? generateId(collectionName);
    const doc = {
      ...req.body,
      _id,
      created_at: req.body.created_at ?? isoNow(),
    };
    await collection().insertOne(doc);
    const saved = await collection().findOne({ _id });
    return sendSuccess(res, saved, 201);
  };

  const update: CrudHandler = async (req, res) => {
    const id = req.params.id;
    if (!id) return sendError(res, 400, "Missing id");
    const existing = await collection().findOne({ _id: id });
    if (!existing) return sendError(res, 404, `${collectionName} not found`);
    const patch = { ...req.body };
    delete patch._id;
    await collection().updateOne({ _id: id }, { $set: patch });
    const updated = await collection().findOne({ _id: id });
    return sendSuccess(res, updated);
  };

  const remove: CrudHandler = async (req, res) => {
    const id = req.params.id;
    if (!id) return sendError(res, 400, "Missing id");
    const result = await collection().deleteOne({ _id: id });
    if (!result.deletedCount) return sendError(res, 404, `${collectionName} not found`);
    return sendSuccess(res, { message: "Deleted", id });
  };

  return { findAll, findById, create, update, remove };
}