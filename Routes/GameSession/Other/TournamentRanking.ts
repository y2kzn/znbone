import { Router } from "express";
import { Request, Response } from "express";
import { BackboneUser } from "../../Models/BackboneUser";

const App = Router();

App.get("/ranking/tournaments", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      BackboneUser.find({ TournamentsWon: { $gt: 0 } })
        .sort({ TournamentsWon: -1 })
        .skip(skip)
        .limit(limit)
        .select("UserId Username TournamentsWon")
        .lean(),
      BackboneUser.countDocuments({ TournamentsWon: { $gt: 0 } }),
    ]);

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      ranking: users.map((user, index) => ({
        position: skip + index + 1,
        userId: user.UserId,
        username: user.Username,
        tournamentsWon: user.TournamentsWon,
      })),
    });
  } catch (error) {
    console.error("[TournamentRanking] error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch ranking" });
  }
});

App.get("/ranking/tournaments/user", async (req: Request, res: Response) => {
  try {
    const userId = req.headers["user-id"] as string;
    if (!userId) return res.status(400).json({ success: false, message: "user-id header is required" });

    const user = await BackboneUser.findOne({ UserId: userId })
      .select("UserId Username TournamentsWon")
      .lean();

    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const position = await BackboneUser.countDocuments({ TournamentsWon: { $gt: user.TournamentsWon } }) + 1;

    return res.status(200).json({
      success: true,
      userId: user.UserId,
      username: user.Username,
      tournamentsWon: user.TournamentsWon,
      position,
    });
  } catch (error) {
    console.error("[TournamentRanking] user error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch user data" });
  }
});

export default {
  App,
  DefaultAPI: "/api",
};
