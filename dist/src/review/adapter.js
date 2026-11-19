import { ponytailReview } from "./ponytail.js";
import { superpowersReview } from "./superpowers.js";
import { uiQaReview } from "./ui-qa.js";
export const reviewAdapters = new Map([superpowersReview, ponytailReview, uiQaReview].map((adapter) => [adapter.id, adapter]));
