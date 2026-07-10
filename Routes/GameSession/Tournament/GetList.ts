import { Router } from "express";
import j from "joi";
import { GetTournamentList } from "../../Backbone/Logic/TournamentList";
import { AppId } from "../../Modules/Constants";
import { msg } from "../../Modules/Logger";

const App = Router();
const TournamentListSchema = j
  .object({
    backbone_app_id: j.string().required().valid(AppId),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

const GetListBodySchema = j
  .object({
    sinceDate: j.date().required(),
    untilDate: j.date().required(),
    maxResults: j.number().required(),
    page: j.number().required(),
    accessToken: j.string().required(),
  })
  .unknown(true);

App.post(
  "/tournamentGetList",
  async (req, res) => {
    const requestId = Math.random().toString(36).slice(2, 8);
    const startedAt = Date.now();
    const slowTimer = setTimeout(() => {
      msg(
        `tournamentGetList:${requestId} still processing after ${Date.now() - startedAt}ms`,
      );
    }, 1000);
    msg(
      `tournamentGetList:${requestId} start page=${req.body.page} max=${req.body.maxResults} since=${req.body.sinceDate} until=${req.body.untilDate} accessTokenLen=${
        req.body.accessToken?.length ?? 0
      } unity=${req.headers["x-unity-version"]}`,
    );
    try {
      const Data = await GetTournamentList(
        req.body.maxResults as number,
        req.body.page as number,
        req.body.accessToken as string
      );
      clearTimeout(slowTimer);
      msg(
        `tournamentGetList:${requestId} ok count=${Data.tournaments?.length ?? 0} durationMs=${
          Date.now() - startedAt
        }`,
      );
      res.json(Data).status(200);
    } catch (error) {
      clearTimeout(slowTimer);
      msg(
        `tournamentGetList:${requestId} failed durationMs=${Date.now() - startedAt} err=${error}`,
      );
      res.status(500).json({ error: "tournamentGetList_failed" });
    }
  }
);
export default {
  App,
  DefaultAPI: "/api/v2",
};

