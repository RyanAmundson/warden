import { codeReview } from "./code-review.js";
import { componentQualityReview } from "./component-quality.js";
import { ponytailReview } from "./ponytail.js";
import { superpowersReview } from "./superpowers.js";
import { uiQaReview } from "./ui-qa.js";
export const reviewAdapters = new Map([superpowersReview, ponytailReview, uiQaReview, componentQualityReview, codeReview].map((adapter) => [adapter.id, adapter]));
