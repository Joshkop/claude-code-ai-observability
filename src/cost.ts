import type { TurnTokens, ModelPrice } from "./types.js";

export interface TurnCost {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

export function getPriceForModel(model: string): ModelPrice {
  throw new Error("not implemented");
}

export function computeTurnCost(tokens: TurnTokens, price: ModelPrice): TurnCost {
  throw new Error("not implemented");
}
