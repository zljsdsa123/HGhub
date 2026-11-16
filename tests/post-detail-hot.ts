import { postHot } from "../src/postData";

const results = {
  detailNullUsesCount: postHot({ hot: null, counts: { hot: 4321 } }),
  detailPresentWins: postHot({ hot: 21, counts: { hot: 4321 } }),
  missingCountsFallsBackToZero: postHot({ hot: null }),
  absentPostFallsBackToZero: postHot(null),
};

document.querySelector("#result")!.textContent = JSON.stringify(results);
Object.assign(window, { postDetailHotFixture: { results } });
