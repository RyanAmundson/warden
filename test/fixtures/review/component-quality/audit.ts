export const auditGroups = [..."ABCDEFGHIJKLMN"].map((id, index) => ({
  id, scored: [5, 2, 7, 6, 3, 9, 5, 5, 7, 8, 6, 5, 4, 4][index]!, notApplicable: 0, unknown: 0,
}));

export const auditFacets = auditGroups.flatMap(({ id, scored }) =>
  Array.from({ length: scored }, (_, index) => ({ id: `${id}${id === "B" && index === 1 ? 4 : index + 1}`, group: id, status: "applicable", score: 80 })),
);
