import { ponytailReview } from "./ponytail.js";
import { superpowersReview } from "./superpowers.js";
export const reviewAdapters = new Map([superpowersReview, ponytailReview].map((adapter) => [adapter.id, adapter]));
