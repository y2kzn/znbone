import { BackboneUser } from "../../Models/BackboneUser";
import { LPUser } from "../../Models/LPUser";
import { Match } from "../../Models/Matches";
import { Tournament } from "../../Models/Tournament";
import {
  TournamentStatus,
  TournamentUserStatus,
  TournamentMatchStatus,
  TournamentPhaseType,
} from "../Config";
import { GetNextPhaseStarted, GetProperties } from "../Settings/Properties";
import {
  GetRulesSettings,
  GetRoundConfigs,
  GetPrizesSettings,
} from "../Settings/Rules";
import {
  GenerateBracketMatches,
  GetUserMatch,
  Qualify,
  GetMatchDeadline,
  AssignNextMatchIfNeeded,
} from "./GetMatches";
import { QualifyTop } from "./Internal/Phase";
import { dbg } from "../../Modules/Logger";

interface PartyMember {
  userId: string;
  status: number;
  checkIn: boolean;
  isPartyLeader: boolean;
  nick: string;
}

export interface PropertyData {
  "@name": string;
  "@value": string | undefined;
}

export interface RoundData {
  "@id": string;
  "@win-score": string;
  "@max-game-count": string;
  "@min-length": string;
  "@max-length": string;
  "@match-point-distribution"?: string;
}

export interface PhaseData {
  "@id": string;
  "@type": string;
  "@max-players": string;
  "@min-teams-per-match": string;
  "@max-teams-per-match": string;
  "@min-checkins-per-team": string;
  "@allow-skip": string;
  "@max-loses"?: string;
  "@game-point-distribution": string;
  "@match-point-distribution": string;
  "@allow-tiebreakers": string;
  "@score-tiebreaker-stats"?: string;
  "@fill-groups-vertically"?: string;
  "@force-unique-matches"?: string;
  "@group-count"?: string;
  "@match-point-distribution-custom"?: string;
  "@preferred-rematch-gap"?: string;
  round: RoundData[];
}

interface UserMatchResponse {
  id: string;
  secret: string;
  deadline: string;
  matchid: number;
  phaseid: number;
  groupid: number;
  roundid: number;
  playedgamecount: number;
  status: number;
  users: Array<{
    "@user-id": string;
    "@team-id": string;
    "@checked-in": string;
    "@user-score": string;
    "@team-score": string;
    "@user-points": string;
    "@team-points": string;
    "@match-points": string;
    "@match-winner": string;
    "@nick": string;
  }>;
}

interface TournamentDataItem {
  id: number | string;
  type: string | number;
  status: number;
  tournamenttime: string;
  cashStatus: number;
  cashTournament: boolean;
  season: number;
  seasonpart: number;
  invitationopens: string;
  invitationcloses: string;
  maxinvites: number;
  partysize: number;
  currentinvites: number;
  phasecount: number;
  roundcount: number;
  sponsorimage: string;
  sponsorname: string;
  currentphaseid: number;
  currentphasestarted: string | null;
  nextphase: null | string;
  name: string;
  image: null;
  icon: string | undefined | null;
  "theme-color": string | undefined | null;
  data: {
    "tournament-data": {
      "invitation-setting": Array<{
        requirements?: Array<{
          "custom-requirement": Array<{
            "@name": string;
            "@value": string;
          }>;
        }>;
        "entry-fee"?: Array<{
          item: Array<{
            "@amount": string;
            "@type": string;
            "@id": string;
            "@external-id": string;
          }>;
        }>;
      }>;
      "rules-setting": Array<{
        phase: PhaseData[];
      }>;
      "prize-setting": Array<{
        reward: Array<{
          "@position": string;
          item: Array<{
            "@amount": string;
            "@type": string;
            "@id": string;
            "@external-id": string;
          }>;
        }>;
      }>;
      "property-setting": Array<{
        properties: Array<{
          property: PropertyData[];
        }>;
      }>;
      "description-data": Array<{
        language: Array<{
          "@code": string;
          name: Array<{
            "#text": Array<{
              value: string;
            }>;
          }>;
          policy: Array<{
            "@url": string;
          }>;
          general: Array<{
            "@main-icon": string | undefined;
            "@theme-color": string | undefined;
          }>;
        }>;
      }>;
      "sponsor-data": Array<{
        "@name": string;
        "@image": string;
      }>;
      "stream-data": Array<{
        "@stream-link": string;
      }>;
      "winner-data"?: Array<{
        user: Array<{ "@user-id": string; "@nick": string }>;
      }>;
    };
  };
  privateCode: null;
  inviteId: string | number | null;
  inviteAceptedAt: string | null;
  inviteDeclinedAt: null;
  inviteStatus: number;
  invitePartyId: unknown;
  inviteIsPartyLeader: boolean;
  invitePartyCode: null | string;
  checkIn: boolean;
  prizeDelivered: null | boolean;
  userPlace: number;
  isAdministrator: boolean;
  openregistration?: number;
  streamurl: string;
}

interface TournamentResponse {
  party: PartyMember[];
  userPosition: unknown[];
  userMatch: UserMatchResponse | null;
  userMatches: UserMatchResponse[];
  tournamentData: TournamentDataItem[];
}


function FormatMatchDeadline(MatchData: any) {
  if (!MatchData) return null;

  if (MatchData.deadline instanceof Date) {
    MatchData.deadline = MatchData.deadline.toISOString();
  }

  const Now = new Date();
  const DeadlineDate = MatchData.deadline ? new Date(MatchData.deadline) : null;

  if (DeadlineDate && MatchData.users && MatchData.id) {
    const NoHaveCheckedIn = !MatchData.users.some(
      (user: any) => user["@checked-in"] === "1"
    );

    const DeadlinePassed =
      Now.getTime() > DeadlineDate.getTime();
    const NoWinner = !MatchData.users.some(
      (user: any) => user["@match-winner"] === "1"
    );

    if (NoHaveCheckedIn && DeadlinePassed && NoWinner) {
      const newDeadline = new Date(Now.getTime() + 10 * 60 * 1000);
      MatchData.deadline = newDeadline.toISOString();

      Match.updateOne(
        { id: MatchData.id },
        { $set: { deadline: newDeadline } }
      ).catch(() => {});
    }
  }

  return MatchData;
}

function summarizeMatch(MatchData: any): string {
  if (!MatchData) return "none";
  const users = Array.isArray(MatchData.users) ? MatchData.users : [];
  const checkedIn = users.filter((u: any) => u["@checked-in"] === "1").length;
  const teamCount = new Set(
    users.map((u: any) => u["@team-id"]).filter((t: string) => t)
  ).size;
  return `id=${MatchData.id} status=${MatchData.status} round=${MatchData.roundid} teams=${teamCount} users=${users.length} checkedIn=${checkedIn}`;
}

function summarizeUser(User: any, TournamentId: string): string {
  if (!User) return "none";
  const Data = (User.Tournaments as any).get
    ? (User.Tournaments as any).get(TournamentId)
    : User.Tournaments?.[TournamentId];
  if (!Data) return `uid=${User.UserId} noData=1`;
  const partySize = Data.PartyMembers?.length ?? 0;
  const isLeader = Data.PartyMembers?.some(
    (pm: any) => pm.IsPartyLeader && pm.UserId === User.UserId
  )
    ? 1
    : 0;
  return `uid=${User.UserId} signed=${Data.SignedUp ? 1 : 0} matchId=${Data.UserMatch?.id || "none"} partySize=${partySize} isLeader=${isLeader}`;
}

export async function TournamentGetData(
  TournamentId: number,
  GetAll: number,
  Ready: number,
  Token: string
): Promise<TournamentResponse | { message: string }> {
  const dbUpdates = [];
  const ReadyFlag = Number(Ready) === 1 ? 1 : 0;
  const GetAllFlag = Number(GetAll) === 1 ? 1 : 0;

  const [Tour, LPAccount] = await Promise.all([
    Tournament.findOne({ TournamentId }),
    LPUser.findOne({ AccessToken: Token }).lean(),
  ]);

  if (!Tour || !LPAccount) return { message: "" };

  const User = await BackboneUser.findOne({ UserId: LPAccount.UserId });
  if (!User) return { message: "" };

  const Info = User.Tournaments?.get(TournamentId.toString());
  const IsSignedUp = !!Info?.SignedUp;
  const PartyUserIds = Info?.PartyMembers?.map((pm: any) => pm.UserId) || [];
  const UserMatchId = Info?.UserMatch?.id;

  const Phase = Tour.CurrentPhaseId || 1;

  const [SignedCount, Team, ValidateMatchData, DatabaseMatch, AllMatches] =
    await Promise.all([
      BackboneUser.countDocuments({
        [`Tournaments.${TournamentId}`]: { $exists: true },
        [`Tournaments.${TournamentId}.SignedUp`]: true,
      }),
      BackboneUser.find({ UserId: { $in: PartyUserIds } })
        .select("UserId Username")
        .lean(),
      UserMatchId
        ? Match.findOne({
            id: UserMatchId,
            status: {
              $in: [
                TournamentMatchStatus.Closed,
                TournamentMatchStatus.GameFinished,
              ],
            },
          })
            .select("id")
            .lean()
        : Promise.resolve(null),
      GetUserMatch(User, Tour),
      Match.find({
        tournamentid: TournamentId.toString(),
        phaseid: Phase,
        groupid: 0,
      })
        .select("roundid status")
        .lean(),
    ]);
  const ResolvedMatch =
    DatabaseMatch ||
    (UserMatchId
      ? await Match.findOne({ id: UserMatchId }).lean()
      : null);

  const Opens = new Date(Tour.SignupStart);
  const Starts = new Date(Tour.StartTime);
  const Now = new Date();
  const ForceRunning =
    Tour.Status === TournamentStatus.Running || !!Tour.CurrentPhaseStarted;
  const EffectiveStarts = ForceRunning ? Now : Starts;
  const EffectiveOpens = ForceRunning
    ? new Date(Now.getTime() - 1000)
    : Opens;
  const EffectiveCloses = new Date(EffectiveStarts.getTime() - 75 * 1000);
  const IsBeforeStart = Now < EffectiveStarts;

  let Status = TournamentStatus.NotStarted;

  if (Tour.CurrentInvites !== SignedCount) {
    Tour.CurrentInvites = SignedCount;
    dbUpdates.push(Tour.save());
  }

  dbg(
    `tournamentGetData: tid=${TournamentId} uid=${User.UserId} getAll=${GetAllFlag} ready=${ReadyFlag} signed=${Info?.SignedUp ? 1 : 0} match=${summarizeMatch(
      Info?.UserMatch
    )}`
  );
  dbg(
    `tournamentGetData: tid=${TournamentId} uid=${User.UserId} readyRaw=${Ready} getAllRaw=${GetAll}`
  );
  dbg(
    `tournamentGetData: tid=${TournamentId} uid=${User.UserId} userMatchId=${UserMatchId || "none"} dbMatch=${summarizeMatch(
      ResolvedMatch
    )}`
  );
  dbg(
    `tournamentGetData: tid=${TournamentId} user=${summarizeUser(
      User,
      TournamentId.toString()
    )} phase=${Phase} signedCount=${SignedCount}`
  );

  if (
    Tour.Status !== TournamentStatus.Canceled &&
    Tour.Status !== TournamentStatus.Finished
  ) {
    if (Now < EffectiveOpens) {
      Status = TournamentStatus.NotStarted;
    } else if (Now <= EffectiveCloses) {
      Status = TournamentStatus.InvitationOpen;
    } else if (Now < EffectiveStarts) {
      Status = TournamentStatus.InvitationClose;
      dbUpdates.push(GenerateBracketMatches(Tour));
    } else {
      if (!Tour.CurrentPhaseStarted) {
        Tour.CurrentPhaseId = 1;
        Tour.CurrentPhaseStarted = new Date();
        Tour.NextPhaseStarted = new Date(
          Date.now() + (await GetNextPhaseStarted(Tour))
        );
        dbUpdates.push(Tour.save());
      }

      Status = TournamentStatus.Running;
      Tour.Status = Status;

      const nextPhaseDate = Tour.NextPhaseStarted;
      nextPhaseDate.setMinutes(nextPhaseDate.getMinutes() - 1);

      if (Tour.NextPhaseStarted && Now >= nextPhaseDate) {
        const CurrentPhaseId = Tour.CurrentPhaseId;
        const CurrentPhase = Tour.Phases[CurrentPhaseId - 1];

        if (CurrentPhase && CurrentPhaseId <= Tour.Phases.length) {
          const NextPhaseId = CurrentPhaseId + 1;
          if (Tour.Phases[NextPhaseId - 1]) {
            const PhaseTypeNum =
              Number(CurrentPhase.PhaseType) ||
              TournamentPhaseType.SingleEliminationBracket;
            const PhaseType = TournamentPhaseType[
              PhaseTypeNum
            ] as keyof typeof TournamentPhaseType;

            if (
              (PhaseType === "RoundRobin" || PhaseType === "Arena") &&
              CurrentPhase.IsPhase &&
              CurrentPhase.GroupCount
            ) {
              const Groups = CurrentPhase.GroupCount;
              const NextMax = Tour.Phases[NextPhaseId - 1].MaxTeams || 0;
              const PerGroup = Math.floor(NextMax / Groups);

              for (let G = 1; G <= Groups; G++) {
                dbUpdates.push(
                  QualifyTop(
                    Tour.TournamentId.toString(),
                    CurrentPhaseId,
                    G,
                    PerGroup
                  )
                );
              }
            }
          }

          const Delay = await GetNextPhaseStarted(Tour, CurrentPhaseId + 1);
          Tour.CurrentPhaseId = CurrentPhaseId + 1;
          Tour.CurrentPhaseStarted = new Date();
          Tour.NextPhaseStarted = new Date(Date.now() + Delay);
          dbUpdates.push(Tour.save());

          dbUpdates.push(GenerateBracketMatches(Tour));
        }
      }

      const IsFinalPhase = Phase === Tour.Phases.length;

      if (IsFinalPhase) {
        let LastRoundNumber = 0;
        AllMatches.forEach((MatchDoc) => {
          if (MatchDoc.roundid > LastRoundNumber)
            LastRoundNumber = MatchDoc.roundid;
        });
        const LastRoundMatches = AllMatches.filter(
          (m) => m.roundid === LastRoundNumber
        );
        const AllLastRoundClosed =
          LastRoundMatches.length > 0 &&
          LastRoundMatches.every(
            (m) =>
              m.status === TournamentMatchStatus.Closed ||
              m.status === TournamentMatchStatus.GameFinished
          );

        if (AllLastRoundClosed) {
          Tour.Status = TournamentStatus.Finished;
          Status = TournamentStatus.Finished;
          dbUpdates.push(Tour.save());
        }
      }
    }
  } else Status = Tour.Status;

  if (
    IsSignedUp &&
    Status === TournamentStatus.NotStarted &&
    Now < EffectiveOpens
  ) {
    Status = TournamentStatus.InvitationOpen;
  }

  const RulesSettings = GetRulesSettings(Tour);

  let CalculatedAllowSkip = "0";

  if (Info && Now >= EffectiveStarts && !Info.KnockedOut) {
    const CurrentPhaseId = Tour.CurrentPhaseId || 1;
    if (CurrentPhaseId > 1 && CurrentPhaseId <= Tour.Phases.length) {
      const UserPosition = Info.UserPosition?.find(
        (P: any) => P.phaseid === CurrentPhaseId - 1
      );
      if (UserPosition && UserPosition.rankposition) {
        const PreviousPhase = Tour.Phases[CurrentPhaseId - 2];
        const CurrentPhase = Tour.Phases[CurrentPhaseId - 1];
        const CurrentPhaseStarted = Tour.CurrentPhaseStarted;

        if (
          PreviousPhase &&
          CurrentPhase &&
          CurrentPhaseStarted &&
          Now >= CurrentPhaseStarted
        ) {
          const UserRank = UserPosition.rankposition;
          const UserGroupId = UserPosition.groupid || 0;
          const PreviousGroupCount = PreviousPhase.GroupCount || 1;
          const PassingThreshold = Math.floor(
            CurrentPhase.MaxTeams / PreviousGroupCount
          );

          if (UserGroupId > 0 && UserRank > 0 && UserRank <= PassingThreshold) {
            CalculatedAllowSkip = "1";
          }
        }
      }
    }
  }
  const Response: TournamentResponse = {
    party: [],
    userPosition: [],
    userMatch: null,
    userMatches: [],
    tournamentData: [
      {
        id: Tour.TournamentId,
        type: Tour.TournamentType,
        status: Status,
        tournamenttime: Tour.StartTime.toISOString(),
        cashStatus: 0,
        cashTournament: false,
        season: 1,
        seasonpart: 1,
        invitationopens: (IsSignedUp && Now < EffectiveOpens ? Now : EffectiveOpens).toISOString(),
        invitationcloses: EffectiveCloses.toISOString(),
        maxinvites: Tour.MaxInvites,
        partysize: Tour.PartySize,
        currentinvites: Tour.CurrentInvites,
        phasecount: Tour.Phases.length,
        roundcount: Tour.RoundCount,
        sponsorimage: "",
        sponsorname: "",
        currentphaseid: Tour.CurrentPhaseId || 0,
        currentphasestarted: Tour.CurrentPhaseStarted?.toISOString() || null,
        nextphase: Tour.NextPhaseStarted
          ? Tour.NextPhaseStarted.toISOString()
          : null,
        name: Tour.TournamentName,
        image: null,
        icon: Tour.TournamentImage,
        "theme-color": Tour.TournamentColor,
        data: {
          "tournament-data": {
            "invitation-setting": [
              {
                requirements: [
                  {
                    "custom-requirement": [
                      {
                        "@name": "server_region",
                        "@value": Tour.Region.toLowerCase(),
                      },
                    ],
                  },
                ],
              },
            ],
            "rules-setting": [RulesSettings],
            "prize-setting": [GetPrizesSettings(Tour)],
            "property-setting": GetProperties(Tour),
            "description-data": [
              {
                language: [
                  {
                    "@code": "en",
                    name: [{ "#text": [{ value: Tour.TournamentName }] }],
                    policy: [{ "@url": "" }],
                    general: [
                      {
                        "@main-icon": Tour.TournamentImage,
                        "@theme-color": Tour.TournamentColor,
                      },
                    ],
                  },
                ],
              },
            ],
            "sponsor-data": [{ "@name": "", "@image": "" }],
            "stream-data": [
              { "@stream-link": Tour.Properties.StreamURL },
            ],
            "winner-data": Tour.Winners?.length
              ? [
                  {
                    user: Tour.Winners.map((W) => ({
                      "@user-id": W.userId,
                      "@nick": W.nick,
                    })),
                  },
                ]
              : undefined,
          },
        },
        privateCode: null,
        inviteId: null,
        inviteAceptedAt: null,
        inviteDeclinedAt: null,
        inviteStatus: TournamentUserStatus.Confirmed,
        invitePartyId: null,
        inviteIsPartyLeader: false,
        invitePartyCode: null,
        checkIn: true,
        prizeDelivered: null,
        userPlace: 0,
        isAdministrator: false,
        streamurl: Tour.Properties.StreamURL
      },
    ],
  };

  const IsAdmin = Tour.Properties.AdminIds.includes(User.UserId);
  const IsInviteOnly = Tour.Properties?.IsInvitationOnly;
  const IsInvited =
    IsInviteOnly && Tour.Properties?.InvitedIds?.includes(User.UserId);
  if (IsAdmin) Response.tournamentData[0].isAdministrator = true;
  if ((IsInviteOnly && IsInvited) || !IsInviteOnly)
    Response.tournamentData[0].openregistration = 0;

  if (Tour.EntryFee && Tour.EntryFee > 0) {
    Response.tournamentData[0].data["tournament-data"][
      "invitation-setting"
    ].push({
      "entry-fee": [
        {
          item: [
            {
              "@amount": Tour.EntryFee.toString(),
              "@type": "10",
              "@id": Tour.PrizepoolId?.toString() || "null",
              "@external-id": "4",
            },
          ],
        },
      ],
    });
  }

  if (
    CalculatedAllowSkip === "1" &&
    Tour.CurrentPhaseId > 1 &&
    RulesSettings.phase[Tour.CurrentPhaseId - 2]
  ) {
    RulesSettings.phase[Tour.CurrentPhaseId - 2]["@allow-skip"] = "1";
  }

  if (!Info?.SignedUp) {
    Response.tournamentData[0].status = Status;
    if (dbUpdates.length > 0) await Promise.all(dbUpdates);
    return Response;
  }

  if (IsInviteOnly && !IsInvited) {
    Info.SignedUp = false;
    Tour.CurrentInvites -= 1;
    dbUpdates.push(User.save());
    dbUpdates.push(Tour.save());
    Response.tournamentData[0].status = Status;
    if (dbUpdates.length > 0) await Promise.all(dbUpdates);
    return Response;
  }

  Response.tournamentData[0].inviteId = Info.InviteId?.toString() || null;
  Response.tournamentData[0].invitePartyId = Info.InviteId?.toString() || null;
  if (Tour.PartySize > 1)
    Response.tournamentData[0].invitePartyCode = Info.PartyCode || null;
  Response.tournamentData[0].inviteAceptedAt = Info.AcceptedAt.toISOString();
  Response.tournamentData[0].checkIn = true;

  if (Info.PartyMembers) {
    Response.party = Info.PartyMembers.map((PartyUser: any) => ({
      userId: PartyUser.UserId.toString(),
      status: PartyUser.Status || TournamentUserStatus.Confirmed,
      checkIn: true,
      isPartyLeader: PartyUser.IsPartyLeader,
      nick: PartyUser.Username,
    }));

    if (
      User.Username !==
      Response.party.find((p) => p.userId === User.UserId)?.nick
    ) {
      Info.PartyMembers = Info.PartyMembers.map((pm: any) => {
        const fresh = Team.find((u) => u.UserId === pm.UserId);
        return fresh ? { ...pm, Username: fresh.Username } : pm;
      });

      Response.party = Info.PartyMembers.map((PartyUser: any) => ({
        userId: PartyUser.UserId.toString(),
        status: PartyUser.Status || TournamentUserStatus.Confirmed,
        checkIn: true,
        isPartyLeader: PartyUser.IsPartyLeader,
        nick: PartyUser.Username,
      }));

      dbUpdates.push(User.save());
    }

    const CurrentUser = Info.PartyMembers.find(
      (PartyUser: any) => PartyUser.UserId === User.UserId
    );
    if (CurrentUser) {
      Response.tournamentData[0].inviteIsPartyLeader =
        CurrentUser.IsPartyLeader;
      if (Info.PartyMembers.some((any) => any.IsKicked)) {
        Response.tournamentData[0].inviteStatus =
          TournamentUserStatus.KickedOutByAdmin;
      }
    }
  }

  if (IsBeforeStart && ReadyFlag === 0) {
    Response.tournamentData[0].status = Status;
    if (dbUpdates.length > 0) await Promise.all(dbUpdates);
    return Response;
  }

  if (!IsBeforeStart && Info.PartyMembers?.length !== Tour.PartySize && Info.PartyMembers) {
    Info.PartyMembers.forEach(
      (PartyUser: any) => (PartyUser.Status = TournamentUserStatus.PartyNotFull)
    );
    Response.tournamentData[0].inviteStatus = TournamentUserStatus.PartyNotFull;
    dbUpdates.push(User.save());
  }

  Response.userPosition = Info.UserPosition || [];

  if (GetAllFlag === 0) {
    Response.party = [];
    Response.tournamentData = [];
  }

  dbg(
    `tournamentGetData: tid=${TournamentId} uid=${User.UserId} times now=${Now.toISOString()} opens=${EffectiveOpens.toISOString()} closes=${EffectiveCloses.toISOString()} starts=${EffectiveStarts.toISOString()} beforeStart=${IsBeforeStart ? 1 : 0} status=${Status}`
  );

  let CurrentMatchObj: any = null;
  let FallbackMatch: any = null;
  if (!ResolvedMatch && ReadyFlag === 1) {
    FallbackMatch = await Match.findOne({
      tournamentid: TournamentId.toString(),
      phaseid: Phase,
      "users.@user-id": User.UserId.toString(),
      status: {
        $nin: [
          TournamentMatchStatus.Closed,
          TournamentMatchStatus.GameFinished,
        ],
      },
    })
      .sort({ roundid: 1, matchid: 1 })
      .lean();
    dbg(
      `tournamentGetData: tid=${TournamentId} uid=${User.UserId} fallbackMatch=${summarizeMatch(
        FallbackMatch
      )}`
    );
  }

  const ActiveMatch = ResolvedMatch || FallbackMatch;

  if (ActiveMatch) {
    CurrentMatchObj = ActiveMatch;
    Info.UserMatch = ActiveMatch;
    Response.userMatch = FormatMatchDeadline(ActiveMatch);
  }

  if (Info.UserMatch && Info.UserMatch.id && ValidateMatchData) {
    Info.UserMatch = null;
    Response.userMatch = null;
    CurrentMatchObj = null;
    dbUpdates.push(User.save());
  }

  if (Info.UserMatches?.length > 0) {
    Response.userMatches = Info.UserMatches.map((OldMatches: any) =>
      FormatMatchDeadline(OldMatches)
    );
  }

  if (ReadyFlag === 0 && Response.userMatch) {
    Info.UserMatch = ActiveMatch;
    dbUpdates.push(User.save());
  }

  if (ReadyFlag === 1 && GetAllFlag === 1 && !IsBeforeStart) {
    const PhaseConfig = Tour.Phases[Phase - 1];
    const TypeNum =
      Number(PhaseConfig.PhaseType) ||
      TournamentPhaseType.SingleEliminationBracket;
    const PhaseType = TournamentPhaseType[
      TypeNum
    ] as keyof typeof TournamentPhaseType;

    if (PhaseType !== "RoundRobin" && PhaseType !== "Arena") {
      const Pos = Info.UserPosition?.find((Pos: any) => Pos.phaseid === Phase);
      if (Pos && Pos.matchloses > 0) {
        Info.KnockedOut = true;
        dbUpdates.push(User.save());
      }
    }

    if (!Response.userMatch && !Info.KnockedOut) {
      await AssignNextMatchIfNeeded(User, Tour);
      const NewMatch = await GetUserMatch(User, Tour);
      if (NewMatch) {
        CurrentMatchObj = NewMatch;
        Info.UserMatch = NewMatch;
        Response.userMatch = FormatMatchDeadline(NewMatch);
      }
    }
  }

  if (ReadyFlag === 1 && CurrentMatchObj) {
    dbg(
      `ready-checkin: tid=${TournamentId} uid=${User.UserId} getAll=${GetAll} match=${summarizeMatch(
        CurrentMatchObj
      )}`
    );
    if (
      CurrentMatchObj.status === TournamentMatchStatus.Closed ||
      CurrentMatchObj.status === TournamentMatchStatus.GameFinished
    ) {
      Response.userMatch = null;
      Info.UserMatch = null;
      CurrentMatchObj = null;
      dbUpdates.push(User.save());
      if (dbUpdates.length > 0) await Promise.all(dbUpdates);
      return Response;
    }

    const UserInMatch = CurrentMatchObj.users.find(
      (MatchUser: any) => MatchUser["@user-id"] === User.UserId
    );
    if (!UserInMatch) {
      Response.userMatch = null;
      Info.UserMatch = null;
      CurrentMatchObj = null;
      dbUpdates.push(User.save());
      if (dbUpdates.length > 0) await Promise.all(dbUpdates);
      return Response;
    }

    const WinnerInMatch = CurrentMatchObj.users.find(
      (MatchUser: any) => MatchUser["@match-winner"] === "1"
    );
    if (WinnerInMatch) {
      const WinnerId = WinnerInMatch["@user-id"];
      const Winner = await BackboneUser.findOne({ UserId: WinnerId });
      if (Winner) {
        await Qualify(Winner, Tour);
        if (WinnerId === User.UserId) {
          const UpdatedUser = Winner;
          const UpdatedInfo = UpdatedUser?.Tournaments.get(
            Tour.TournamentId.toString()
          );
          if (UpdatedInfo) {
            const NewMatch = await GetUserMatch(UpdatedUser, Tour);
            CurrentMatchObj = NewMatch;
            Info.UserMatch = NewMatch;
            Response.userMatch = NewMatch
              ? FormatMatchDeadline(NewMatch)
              : null;
            dbUpdates.push(User.save());
            if (UpdatedInfo.UserMatches?.length > 0) {
              Response.userMatches = UpdatedInfo.UserMatches.map(
                (HistoryMatch: any) => FormatMatchDeadline(HistoryMatch)
              );
            }
          }
        }
      }
      if (dbUpdates.length > 0) await Promise.all(dbUpdates);
      return Response;
    }

    if (CurrentMatchObj.status === TournamentMatchStatus.GameInProgress) {
      dbg(
        `checkin-blocked: tid=${TournamentId} uid=${User.UserId} match=${CurrentMatchObj.id} status=GameInProgress`
      );
      if (UserInMatch["@checked-in"] !== "1") {
        Response.userMatch = null;
        Info.UserMatch = null;
        dbUpdates.push(User.save());
      }
      if (dbUpdates.length > 0) await Promise.all(dbUpdates);
      return Response;
    }

    if (UserInMatch["@checked-in"] === "1") {
      const Configs = GetRoundConfigs(Tour);
      const Deadline = GetMatchDeadline(CurrentMatchObj, Tour, Configs);
      const GracePeriod = new Date(Deadline.getTime() + 5000);
      const IsPassedDeadline = Now >= GracePeriod;

      if (IsPassedDeadline) {
        const teams = new Map();
        CurrentMatchObj.users.forEach((user: any) => {
          const teamId = user["@team-id"];
          if (!teams.has(teamId)) {
            teams.set(teamId, {
              teamId,
              players: [],
              allCheckedIn: true,
            });
          }
          const team = teams.get(teamId);
          team.players.push(user);
          if (user["@checked-in"] !== "1") {
            team.allCheckedIn = false;
          }
        });

        const qualifiedTeams = Array.from(teams.values()).filter(
          (team) => team.allCheckedIn
        );

        if (qualifiedTeams.length === 1) {
          const winnerTeam = qualifiedTeams[0];

          const UpdatedUsers = CurrentMatchObj.users.map((MatchUser: any) => {
            if (MatchUser["@team-id"] === winnerTeam.teamId) {
              return {
                ...MatchUser,
                "@match-winner": "1",
                "@match-points": "1",
                "@team-score": "1",
              };
            }
            return {
              ...MatchUser,
              "@match-winner": "0",
              "@match-points": "0",
              "@team-score": "0",
            };
          });

          CurrentMatchObj.users = UpdatedUsers;
          CurrentMatchObj.status = TournamentMatchStatus.Closed;

          if (Response.userMatch) {
            Response.userMatch.status = TournamentMatchStatus.Closed;
            Response.userMatch.users = UpdatedUsers;
          }

          const WinnerUserId = winnerTeam.players[0]["@user-id"];
          const WinnerUser = await BackboneUser.findOne({
            UserId: WinnerUserId,
          });

          if (WinnerUser) {
            await Qualify(WinnerUser, Tour);
          }

          dbUpdates.push(
            Match.updateOne(
              { id: CurrentMatchObj.id },
              {
                $set: {
                  users: UpdatedUsers,
                  status: TournamentMatchStatus.Closed,
                },
              }
            )
          );

          if (WinnerUserId === User.UserId) {
            const UpdatedInfo = User?.Tournaments.get(
              Tour.TournamentId.toString()
            );
            if (UpdatedInfo) {
              const NewMatch = await GetUserMatch(User, Tour);
              CurrentMatchObj = NewMatch;
              Info.UserMatch = NewMatch;
              Response.userMatch = NewMatch
                ? FormatMatchDeadline(NewMatch)
                : null;
              dbUpdates.push(User.save());
              if (UpdatedInfo.UserMatches?.length > 0) {
                Response.userMatches = UpdatedInfo.UserMatches.map(
                  (HistoryMatch: any) => FormatMatchDeadline(HistoryMatch)
                );
              }
            }
          }

          if (dbUpdates.length > 0) await Promise.all(dbUpdates);
          return Response;
        }

        if (qualifiedTeams.length === 0) {
          const UpdatedUsers = CurrentMatchObj.users.map((MatchUser: any) => ({
            ...MatchUser,
            "@match-winner": "0",
            "@match-points": "0",
            "@team-score": "0",
          }));

          CurrentMatchObj.users = UpdatedUsers;
          CurrentMatchObj.status = TournamentMatchStatus.Closed;

          if (Response.userMatch) {
            Response.userMatch.status = TournamentMatchStatus.Closed;
            Response.userMatch.users = UpdatedUsers;
          }

          dbUpdates.push(
            Match.updateOne(
              { id: CurrentMatchObj.id },
              {
                $set: {
                  users: UpdatedUsers,
                  status: TournamentMatchStatus.Closed,
                },
              }
            )
          );

          if (dbUpdates.length > 0) await Promise.all(dbUpdates);
          return Response;
        }
      }
    }

    UserInMatch["@checked-in"] = "1";
    if (Response.userMatch) {
      Response.userMatch.users = CurrentMatchObj.users.map((user: any) => ({
        ...user,
      }));
    }

    const CheckinResult = await Match.updateOne(
      {
        id: CurrentMatchObj.id,
        status: {
          $nin: [
            TournamentMatchStatus.Closed,
            TournamentMatchStatus.GameFinished,
            TournamentMatchStatus.GameInProgress,
          ],
        },
      },
      { $set: { "users.$[elem].@checked-in": "1" } },
      { arrayFilters: [{ "elem.@user-id": User.UserId.toString() }] }
    );
    dbg(
      `checkin-update: tid=${TournamentId} uid=${User.UserId} match=${CurrentMatchObj.id} matched=${CheckinResult.matchedCount} modified=${CheckinResult.modifiedCount}`
    );

    if (CheckinResult.modifiedCount === 0) {
      const FallbackResult = await Match.updateOne(
        {
          id: CurrentMatchObj.id,
          "users.@user-id": User.UserId.toString(),
          status: {
            $nin: [
              TournamentMatchStatus.Closed,
              TournamentMatchStatus.GameFinished,
              TournamentMatchStatus.GameInProgress,
            ],
          },
        },
        { $set: { "users.$.@checked-in": "1" } }
      );
      dbg(
        `checkin-fallback: tid=${TournamentId} uid=${User.UserId} match=${CurrentMatchObj.id} matched=${FallbackResult.matchedCount} modified=${FallbackResult.modifiedCount}`
      );
    }

    if (
      CurrentMatchObj.status === TournamentMatchStatus.WaitingForOpponent ||
      CurrentMatchObj.status === TournamentMatchStatus.Created
    ) {
      const UniqueTeams = new Set(
        CurrentMatchObj.users
          .map((U: any) => U["@team-id"])
          .filter((T: string) => T)
      );
      if (UniqueTeams.size === Tour.MaxPlayersPerMatch) {
        const Configs = GetRoundConfigs(Tour);
        const Config = Configs.get(CurrentMatchObj.roundid);
        let NewDeadline: Date;
        if (Config) {
          const GameCount = Config.MaxGameCount;
          const TotalMinutes = GameCount * Config.MinGameLength;
          const AdjustedMinutes =
            TotalMinutes === Config.MaxLength ? TotalMinutes - 1 : TotalMinutes;
          const SubtractedTime = AdjustedMinutes * 60 * 1000 + 15000;
          const CheckInTime = 5 * 60 * 1000;
          NewDeadline = new Date(Date.now() + CheckInTime + SubtractedTime);
        } else {
          NewDeadline = new Date(Date.now() + 5 * 60 * 1000);
        }

        CurrentMatchObj.status = TournamentMatchStatus.GameReady;
        CurrentMatchObj.deadline = NewDeadline;
        if (Response.userMatch) {
          Response.userMatch.status = TournamentMatchStatus.GameReady;
          Response.userMatch.deadline = NewDeadline.toISOString();
        }

        dbg(
          `match-ready: tid=${TournamentId} uid=${User.UserId} match=${CurrentMatchObj.id} teams=${UniqueTeams.size}/${Tour.MaxPlayersPerMatch}`
        );

        dbUpdates.push(
          Match.updateOne(
            {
              id: CurrentMatchObj.id,
              status: {
                $in: [
                  TournamentMatchStatus.Created,
                  TournamentMatchStatus.WaitingForOpponent,
                ],
              },
            },
            {
              $set: {
                status: TournamentMatchStatus.GameReady,
                deadline: NewDeadline,
              },
            }
          )
        );
      } else if (
        CurrentMatchObj.status === TournamentMatchStatus.Created &&
        UniqueTeams.size >= 1
      ) {
        dbg(
          `match-waiting: tid=${TournamentId} uid=${User.UserId} match=${CurrentMatchObj.id} teams=${UniqueTeams.size}/${Tour.MaxPlayersPerMatch}`
        );
        CurrentMatchObj.status = TournamentMatchStatus.WaitingForOpponent;
        if (Response.userMatch) {
          Response.userMatch.status = TournamentMatchStatus.WaitingForOpponent;
        }
        dbUpdates.push(
          Match.updateOne(
            {
              id: CurrentMatchObj.id,
              status: TournamentMatchStatus.Created,
            },
            { $set: { status: TournamentMatchStatus.WaitingForOpponent } }
          )
        );
      }
    }

    dbUpdates.push(User.save());
  }

  if (Info.UserMatch && !Info.UserMatch.id) {
    const NewMatch = await GetUserMatch(User, Tour);
    if (NewMatch) {
      CurrentMatchObj = NewMatch;
      Info.UserMatch = NewMatch;
      dbUpdates.push(User.save());
    }
  }

  if (
    Info.KnockedOut ||
    Info.PartyMembers?.some((me) => me.UserId == User.UserId && me.IsKicked)
  ) {
    Response.userMatch = null;
    if (Info.UserMatches?.length > 0) {
      Response.userMatches = Info.UserMatches.map((Match: any) =>
        FormatMatchDeadline(Match)
      );
    }
    Response.userPosition = Info.UserPosition || [];
  }

  if (Info.FinalPlace > 0) {
    Response.tournamentData[0].userPlace = Info.FinalPlace;
    Response.tournamentData[0].prizeDelivered = true;
  }

  if (dbUpdates.length > 0) await Promise.all(dbUpdates);
  return Response;
}
