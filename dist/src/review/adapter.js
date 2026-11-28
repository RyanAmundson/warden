import { codeReview } from "./code-review.js";
import { componentQualityReview } from "./component-quality.js";
import { ponytailReview } from "./ponytail.js";
import { superpowersReview } from "./superpowers.js";
import { uiQaReview } from "./ui-qa.js";
export const builtInReviewAdapters = [
    [superpowersReview, "Reviews a change against its requirements with an independent agent."],
    [ponytailReview, "Reviews a change for unnecessary complexity."],
    [uiQaReview, "Reviews rendered interface behavior and visual quality."],
    [componentQualityReview, "Runs a quality review for a specific UI component."],
    [codeReview, "Reviews a GitHub pull request with the Code Review skill."],
];
export const reviewAdapters = new Map(builtInReviewAdapters.map(([adapter]) => [adapter.id, adapter]));
