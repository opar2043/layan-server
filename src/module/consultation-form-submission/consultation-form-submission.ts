import { createCrudHandlers } from "../../shared/crud";

const crud = createCrudHandlers("consultation_form_submission");

export const findAll = crud.findAll;
export const findById = crud.findById;
export const create = crud.create;
export const update = crud.update;
export const remove = crud.remove;
