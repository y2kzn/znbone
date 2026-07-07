import { BackboneUser } from "../../Models/BackboneUser";
import { LPUser } from "../../Models/LPUser";
import { ITournament, Tournament } from "../../Models/Tournament";
import { TournamentStatus, TournamentUserStatus } from "../Config";
import { GetProperties } from "../Settings/Properties";
import { GetPrizesSettings, GetRulesSettings } from "../Settings/Rules";
import { dbg, msg } from "../../Modules/Logger";

export async function GetTournamentList(
  MaxResults: number,
  Page: number,
  AccessToken: string,
) {
  dbg(
    `GetTournamentList: request page=${Page} max=${MaxResults} accessTokenLen=${
      AccessToken?.length ?? 0
    }`,
  );
  if (Page <= 0 || MaxResults <= 0) {
    dbg(`GetTournamentList: invalid pagination page=${Page} max=${MaxResults}`);
  }
  const LoginProviderUser = await LPUser.findOne(
    { AccessToken },
    { UserId: 1 },
  ).lean();
  if (!LoginProviderUser) {
    msg(
      `GetTournamentList: no LPUser for accessToken len=${AccessToken?.length ?? 0}`,
    );
    return {
      pagination: {
        currentPage: Page,
        maxResults: MaxResults,
        totalResultCount: 0,
      },
      tournaments: [],
    };
  }
  dbg(
    `GetTournamentList: lpUser=found userId=${LoginProviderUser.UserId ?? "n/a"}`,
  );

  const [TotalCount, TournamentsData, DatabaseUser] = await Promise.all([
    Tournament.countDocuments({ Status: { $ne: TournamentStatus.Canceled } }),
    Tournament.find({ Status: { $ne: TournamentStatus.Canceled } })
      .skip((Page - 1) * MaxResults)
      .limit(MaxResults)
      .lean(),
    BackboneUser.findOne(
      { UserId: LoginProviderUser.UserId },
      { UserId: 1, Tournaments: 1 },
    ),
  ]);
  msg(
    `GetTournamentList: total=${TotalCount} pageCount=${TournamentsData.length} page=${Page} max=${MaxResults}`,
  );

  const DatabaseUserTournaments = DatabaseUser?.Tournaments || new Map();
  const hasMapGet = typeof (DatabaseUserTournaments as any).get === "function";
  const tournamentsType =
    (DatabaseUserTournaments as any)?.constructor?.name ?? "unknown";
  let userTournamentCount = 0;
  if (hasMapGet) {
    userTournamentCount = (DatabaseUserTournaments as Map<string, unknown>).size;
  } else if (DatabaseUserTournaments) {
    userTournamentCount = Object.keys(DatabaseUserTournaments as object).length;
  }
  dbg(
    `GetTournamentList: dbUser=${DatabaseUser ? "found" : "missing"} tournamentsType=${tournamentsType} hasMapGet=${hasMapGet} userTournamentCount=${userTournamentCount}`,
  );
  if (!TournamentsData.length) {
    dbg("GetTournamentList: no tournaments found in db for current page");
  }
  const Now = new Date();
  const Tournaments = [];
  let skippedInviteOnlyNotInvited = 0;
  let inviteOnlyCount = 0;
  let invitedCount = 0;
  let signedUpCount = 0;

  for (let i = 0; i < TournamentsData.length; i++) {
    const Tour = TournamentsData[i];
    try {
      if (Tour.Status === TournamentStatus.Canceled) continue;

      const Opens = Tour.SignupStart;
      const Starts = Tour.StartTime;
      const ForceRunning =
        Tour.Status === TournamentStatus.Running || !!Tour.CurrentPhaseStarted;
      const EffectiveStarts = ForceRunning ? Now : Starts;
      const EffectiveOpens = ForceRunning
        ? new Date(Now.getTime() - 1000)
        : Opens;
      const EffectiveCloses = new Date(EffectiveStarts.getTime() - 75000);

      let Status = TournamentStatus.NotStarted;
      if (Tour.Status === TournamentStatus.Running || ForceRunning) {
        Status = TournamentStatus.Running;
      } else if (Tour.Status !== TournamentStatus.Finished) {
        if (Now < EffectiveOpens) Status = TournamentStatus.NotStarted;
        else if (Now <= EffectiveCloses) Status = TournamentStatus.InvitationOpen;
        else if (Now < EffectiveStarts) Status = TournamentStatus.InvitationClose;
      }
      if (Tour.Status === TournamentStatus.Finished)
        Status = TournamentStatus.Finished;

      const InvitationSetting: any = {
        requirements: [
          {
            "custom-requirement": [
              {
                "@name": "server_region",
                "@value": (Tour.Region || "eu").toLowerCase(),
              },
            ],
          },
        ],
      };

      if (Tour.EntryFee > 0) {
        InvitationSetting["entry-fee"] = [
          {
            item: [
              {
                "@amount": Tour.EntryFee.toString(),
                "@type": "10",
                "@id": Tour.PrizepoolId?.toString(),
                "@external-id": "4",
                "@add-to-pot": "1",
              },
            ],
          },
        ];
      }

      const [RulesSettings, PrizesSettings, Properties] = await Promise.all([
        GetRulesSettings(Tour as unknown as ITournament),
        GetPrizesSettings(Tour as unknown as ITournament),
        GetProperties(Tour as unknown as ITournament),
      ]);

      const TourIdStr = Tour.TournamentId.toString();
      const Info = (DatabaseUserTournaments as any).get(TourIdStr);
      const IsAdmin =
        DatabaseUser && Tour.Properties?.AdminIds?.includes(DatabaseUser.UserId);
      const IsInviteOnly = Tour.Properties?.IsInvitationOnly;
      const IsInvited =
        DatabaseUser &&
        IsInviteOnly &&
        Tour.Properties?.InvitedIds?.includes(DatabaseUser.UserId);

      if (IsInviteOnly) inviteOnlyCount++;
      if (IsInvited) invitedCount++;
      if (Info?.SignedUp) signedUpCount++;

      const TournamentData = {
        id: Tour.TournamentId,
        type: Tour.TournamentType,
        status: Status,
        tournamenttime: Starts.toISOString(),
        cashStatus: 0,
        cashTournament: false,
        season: 1,
        seasonpart: 1,
        invitationopens: EffectiveOpens.toISOString(),
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
        nextphase: Tour.NextPhaseStarted?.toISOString() || null,
        name: Tour.TournamentName,
        image: null,
        icon: Tour.TournamentImage,
        "theme-color": Tour.TournamentColor,
        data: {
          "tournament-data": {
            "invitation-setting": [InvitationSetting],
            "rules-setting": [RulesSettings],
            "prize-setting": [PrizesSettings],
            "property-setting": Properties,
            "description-data": [
              {
                language: [
                  {
                    "@code": "en",
                    name: [{ "#text": [{ value: Tour.TournamentName || "" }] }],
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
            "stream-data": [{ "@stream-link": Tour.Properties?.StreamURL }],
          },
        },
        privateCode: null,
        inviteId: null,
        inviteAceptedAt: null,
        inviteDeclinedAt: null,
        inviteStatus: 0,
        invitePartyId: null,
        inviteIsPartyLeader: false,
        invitePartyCode: null,
        checkIn: false,
        prizeDelivered: null,
        userPlace: 0,
        isAdministrator: IsAdmin,
        openregistration: undefined,
        highlightsurl: null,
        streamurl: Tour.Properties?.StreamURL,
      };

      if (Info?.SignedUp) {
        if (IsInviteOnly && !IsInvited) {
          skippedInviteOnlyNotInvited++;
          continue;
        }

        TournamentData.inviteId = Info.InviteId?.toString() || null;
        TournamentData.invitePartyId = Info.InviteId?.toString() || null;
        TournamentData.inviteStatus = TournamentUserStatus.Confirmed;
        TournamentData.inviteAceptedAt = Info.AcceptedAt?.toISOString() || null;
        TournamentData.checkIn = true;

        if (Tour.PartySize > 1) {
          TournamentData.invitePartyCode = Info.PartyCode || null;
        }

        if (Info.PartyMembers) {
          const CurrentUserInParty = Info.PartyMembers.find(
            (member) => member.UserId === DatabaseUser?.UserId,
          );
          if (CurrentUserInParty) {
            TournamentData.inviteIsPartyLeader =
              CurrentUserInParty.IsPartyLeader;
          }
        }

        if (Info.FinalPlace > 0) {
          TournamentData.userPlace = Info.FinalPlace;
          TournamentData.prizeDelivered = true;
        }
      }

      if (Info?.SignedUp && Status === TournamentStatus.NotStarted && Now < EffectiveOpens) {
        Status = TournamentStatus.InvitationOpen;
      }

      if ((IsInviteOnly && IsInvited) || !IsInviteOnly) {
        TournamentData.openregistration = 0;
      }

      TournamentData.status = Status;
      TournamentData.invitationopens = (
        Info?.SignedUp && Now < EffectiveOpens ? Now : EffectiveOpens
      ).toISOString();
      Tournaments.push(TournamentData);
    } catch (error) {
      dbg(
        `GetTournamentList: build failed tournamentId=${
          Tour?.TournamentId ?? "unknown"
        } err=${error}`,
      );
      throw error;
    }
  }

  dbg(
    `GetTournamentList: outputCount=${Tournaments.length} inviteOnly=${inviteOnlyCount} invited=${invitedCount} signedUp=${signedUpCount} skippedInviteOnlyNotInvited=${skippedInviteOnlyNotInvited}`,
  );
  if (!Tournaments.length) {
    dbg("GetTournamentList: returning empty tournaments list");
  }

  return {
    pagination: {
      currentPage: Page,
      maxResults: MaxResults,
      totalResultCount: TotalCount,
    },
    tournaments: Tournaments,
  };
}
