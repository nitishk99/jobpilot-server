import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mock = {
  transaction: jest.fn(),
  getRepository: jest.fn(),
  findEmails: jest.fn(),
  saveEmails: jest.fn(),
  findApplications: jest.fn(),
  findApplication: jest.fn(),
  saveApplication: jest.fn(),
  query: jest.fn(),
  candidateCondition: jest.fn(),
  candidateCount: jest.fn(),
};

jest.mock("../../../src/config/db.js", () => ({
  AppDataSource: {
    transaction: (...args) => mock.transaction(...args),
  },
}));

import { Application } from "../../../src/database/entities/Application.js";
import { Email } from "../../../src/database/entities/Email.js";
import { processAiProcessedEmailsForUser } from "../../../src/modules/applications/application-processing.service.js";

let emails: Email[];
let applications: Application[];
let nextApplicationId: number;

const emailRepository = {
  find: mock.findEmails,
  save: mock.saveEmails,
  createQueryBuilder: () => createCandidateBuilder("email"),
};

const applicationRepository = {
  find: mock.findApplications,
  findOne: mock.findApplication,
  createQueryBuilder: () => createCandidateBuilder("application"),
  create: (values: Partial<Application>) =>
    Object.assign(new Application(), values),
  save: mock.saveApplication,
};

const manager = {
  getRepository: mock.getRepository,
  query: mock.query,
};

const createCandidateBuilder = (type: "email" | "application") => {
  const params: Record<string, unknown> = {};
  const addCondition = (condition: unknown, values?: Record<string, unknown>) => {
    if (typeof condition === "string") mock.candidateCondition(type, condition, values);
    if (values) Object.assign(params, values);
    if (condition && typeof condition === "object" && "whereFactory" in condition) {
      (condition as { whereFactory: (query: typeof builder) => void }).whereFactory(builder);
    }
    return builder;
  };
  const builder = {
    select: () => builder,
    where: addCondition,
    andWhere: addCondition,
    orWhere: addCondition,
    getMany: async () => {
      if (type === "email") {
        return emails.filter((email) =>
          email.userId === params.userId && email.applicationId &&
          (email.gmailThreadId === params.threadId ||
            (params.jobReferenceId &&
              email.extractedData?.jobReferenceId?.trim() === params.jobReferenceId) ||
            (params.applicationReferenceId &&
              email.extractedData?.applicationReferenceId?.trim() === params.applicationReferenceId)),
        );
      }
      const candidates = applications.filter((application) =>
        application.userId === params.userId &&
        ((params.associatedIds as string[] | undefined)?.includes(application.id) ||
          (params.company && params.title &&
            application.normalizedCompanyName === params.company &&
            application.normalizedJobTitle === params.title)),
      );
      mock.candidateCount(candidates.length);
      return candidates;
    },
  };
  return builder;
};

const makeEmail = (
  id: string,
  receivedAt: string,
  extractedData: Record<string, unknown>,
  userId = "user-1",
): Email =>
  Object.assign(new Email(), {
    id,
    userId,
    applicationId: null,
    associationSource: "AUTO",
    matchingPending: true,
    gmailMessageId: `gmail-${id}`,
    gmailThreadId: `thread-${id}`,
    fromEmail: "jobs@example.com",
    toEmail: "candidate@example.com",
    subject: `Message ${id}`,
    bodyText: "Job application email",
    extractedData,
    receivedAt: new Date(receivedAt),
    createdAt: new Date(receivedAt),
  });

const makeApplication = (
  id: string,
  userId: string,
  companyName: string,
  jobTitle: string,
  status: Application["status"],
): Application => {
  const application = Object.assign(new Application(), {
    id,
    userId,
    companyName,
    jobTitle,
    status,
    source: null,
    appliedAt: null,
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  application.updateMatchKeys();
  return application;
};

const extraction = (
  category: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  isJobRelated: true,
  category,
  companyName: "Acme, Inc.",
  jobTitle: "Senior Software Engineer",
  ...overrides,
});

describe("AI email application processing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emails = [];
    applications = [];
    nextApplicationId = 1;

    mock.getRepository.mockImplementation((entity: unknown) =>
      entity === Email ? emailRepository : applicationRepository,
    );
    mock.findEmails.mockImplementation(
      async ({ where, take }: { where: { userId: string; matchingPending?: boolean; applicationId?: string }; take?: number }) =>
        emails
          .filter(
            (email) =>
              email.userId === where.userId &&
              (where.matchingPending === undefined || email.matchingPending === where.matchingPending) &&
              (where.applicationId === undefined || email.applicationId === where.applicationId),
          )
          .sort(
            (left, right) =>
              left.receivedAt.getTime() - right.receivedAt.getTime() ||
              left.id.localeCompare(right.id),
          ).slice(0, take),
    );
    mock.saveEmails.mockImplementation(async (records: Email[]) => records);
    mock.findApplications.mockImplementation(
      async ({ where }: { where: { userId: string } }) =>
        applications
          .filter((application) => application.userId === where.userId)
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime() ||
              left.id.localeCompare(right.id),
          ),
    );
    mock.findApplication.mockImplementation(
      async ({ where }: { where: { id: string; userId: string } }) =>
        applications.find((application) =>
          application.id === where.id && application.userId === where.userId,
        ) ?? null,
    );
    mock.saveApplication.mockImplementation(
      async (application: Application) => {
        application.updateMatchKeys();
        if (!application.id) {
          application.id = `application-${nextApplicationId}`;
          nextApplicationId += 1;
        }
        const index = applications.findIndex(
          (existing) => existing.id === application.id,
        );
        if (index === -1) {
          applications.push(application);
        } else {
          applications[index] = application;
        }
        return application;
      },
    );
    mock.transaction.mockImplementation(
      async (
        callback: (entityManager: typeof manager) => Promise<unknown>,
      ) => callback(manager),
    );
  });

  it("creates one normalized match, associates emails, and uses the latest status", async () => {
    const applicationEmail = makeEmail(
      "application-email",
      "2026-10-01T10:00:00.000Z",
      extraction("APPLICATION"),
    );
    const interviewEmail = makeEmail(
      "interview-email",
      "2026-10-05T10:00:00.000Z",
      extraction("INTERVIEW", {
        companyName: "ACME",
        jobTitle: "Senior Software Engineer!",
      }),
    );
    emails = [interviewEmail, applicationEmail];

    const summary = await processAiProcessedEmailsForUser("user-1");

    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({
      companyName: "Acme, Inc.",
      jobTitle: "Senior Software Engineer",
      status: "INTERVIEW",
      appliedAt: applicationEmail.receivedAt,
    });
    expect(applicationEmail.applicationId).toBe(applications[0].id);
    expect(interviewEmail.applicationId).toBe(applications[0].id);
    expect(summary).toEqual({
      examined: 2,
      ignored: 0,
      applicationsCreated: 1,
      applicationsMatched: 1,
      emailsAssociated: 2,
      statusesUpdated: 1,
      outcomes: {
        MATCHED: 1,
        NEW_APPLICATION: 1,
        NEEDS_REVIEW: 0,
      },
    });
  });

  it("does not let an older application email downgrade a newer interview status", async () => {
    const applicationEmail = makeEmail(
      "application-email",
      "2026-11-01T10:00:00.000Z",
      extraction("APPLICATION"),
    );
    const interviewEmail = makeEmail(
      "interview-email",
      "2026-11-10T10:00:00.000Z",
      extraction("INTERVIEW"),
    );
    emails = [applicationEmail, interviewEmail];
    await processAiProcessedEmailsForUser("user-1");
    expect(applications[0].status).toBe("INTERVIEW");
    const olderApplicationEmail = makeEmail(
      "older-application-email",
      "2026-11-01T10:00:00.000Z",
      extraction("APPLICATION"),
    );
    emails.push(olderApplicationEmail);
    await processAiProcessedEmailsForUser("user-1");

    expect(applications).toHaveLength(1);
    expect(applications[0].status).toBe("INTERVIEW");

    const offerEmail = makeEmail(
      "offer-email",
      "2026-11-12T10:00:00.000Z",
      extraction("OFFER"),
    );
    emails.push(offerEmail);
    await processAiProcessedEmailsForUser("user-1");

    expect(applications[0].status).toBe("OFFER");
    expect(offerEmail.applicationId).toBe(applications[0].id);
  });

  it("updates status from the latest reliable event and ignores newer HR or document events", async () => {
    const application = makeApplication(
      "anc-java",
      "user-1",
      "ANC Technologies",
      "Java Developer",
      "APPLIED",
    );
    const interview = makeEmail(
      "interview",
      "2026-11-14T10:00:00.000Z",
      extraction("INTERVIEW", {
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        eventType: "INTERVIEW_SCHEDULED",
        eventDate: "2026-11-14T10:00:00.000Z",
      }),
    );
    const offer = makeEmail(
      "offer",
      "2026-11-21T10:00:00.000Z",
      extraction("OFFER", {
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        eventType: "OFFER_RECEIVED",
        eventDate: "2026-11-21T10:00:00.000Z",
      }),
    );
    const documents = makeEmail(
      "documents",
      "2026-11-22T10:00:00.000Z",
      extraction("ASSESSMENT", {
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        eventType: "DOCUMENTS_REQUESTED",
        eventDate: "2026-11-22T10:00:00.000Z",
      }),
    );
    const hrUpdate = makeEmail(
      "hr-update",
      "2026-11-23T10:00:00.000Z",
      extraction("HR_COMMUNICATION", {
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        eventType: "HR_UPDATE",
        eventDate: "2026-11-23T10:00:00.000Z",
      }),
    );
    for (const email of [interview, offer, documents, hrUpdate]) {
      email.applicationId = application.id;
    }
    applications = [application];
    emails = [interview, offer, documents, hrUpdate];

    await processAiProcessedEmailsForUser("user-1");

    expect(application.status).toBe("OFFER");

    const rejection = makeEmail(
      "rejection",
      "2026-11-24T10:00:00.000Z",
      extraction("HR_COMMUNICATION", {
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        eventType: "REJECTION_RECEIVED",
        eventDate: "2026-11-24T10:00:00.000Z",
      }),
    );
    rejection.applicationId = application.id;
    emails.push(rejection);

    await processAiProcessedEmailsForUser("user-1");

    expect(application.status).toBe("REJECTED");
  });

  it("preserves manual associations when automatic processing runs again", async () => {
    const application = makeApplication(
      "manual-application",
      "user-1",
      "ANC Technologies",
      "Java Developer",
      "APPLIED",
    );
    const email = makeEmail(
      "manual-associated-email",
      "2026-11-12T10:00:00.000Z",
      extraction("INTERVIEW", {
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        eventType: "INTERVIEW_SCHEDULED",
      }),
    );
    email.applicationId = application.id;
    email.associationSource = "MANUAL";
    applications = [application];
    emails = [email];

    await processAiProcessedEmailsForUser("user-1");

    expect(applications).toHaveLength(1);
    expect(email.applicationId).toBe(application.id);
    expect(email.associationSource).toBe("MANUAL");
    expect(email.extractedData?.applicationMatchOutcome).toBeUndefined();
  });

  it("preserves a manually unassociated email and never creates an automatic duplicate", async () => {
    const application = makeApplication(
      "manual-unassociated-existing-opening",
      "user-1",
      "ANC Technologies",
      "Java Developer",
      "APPLIED",
    );
    const email = makeEmail(
      "manual-unassociated-email",
      "2026-11-12T10:00:00.000Z",
      extraction("APPLICATION", {
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        eventType: "APPLICATION_RECEIVED",
      }),
    );
    email.associationSource = "MANUAL";
    applications = [application];
    emails = [email];

    await processAiProcessedEmailsForUser("user-1");
    await processAiProcessedEmailsForUser("user-1");

    expect(applications).toHaveLength(1);
    expect(email.applicationId).toBeNull();
    expect(email.associationSource).toBe("MANUAL");
    expect(mock.findEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        lock: { mode: "pessimistic_write" },
      }),
    );
  });

  it("does not match applications belonging to another user", async () => {
    const otherUsersApplication = makeApplication(
      "other-users-app",
      "user-2",
      "ACME",
      "Senior Software Engineer",
      "OFFER",
    );
    applications = [otherUsersApplication];
    const email = makeEmail(
      "user-one-email",
      "2026-11-01T10:00:00.000Z",
      extraction("APPLICATION"),
    );
    emails = [email];

    await processAiProcessedEmailsForUser("user-1");

    expect(applications).toHaveLength(2);
    expect(email.applicationId).not.toBe(otherUsersApplication.id);
    expect(applications.find((application) => application.userId === "user-1"))
      .toBeDefined();
  });

  it("ignores non-job-related and unreliable extractions", async () => {
    emails = [
      makeEmail(
        "non-job",
        "2026-11-01T10:00:00.000Z",
        extraction("APPLICATION", { isJobRelated: false }),
      ),
      makeEmail(
        "uncertain",
        "2026-11-02T10:00:00.000Z",
        extraction("APPLICATION", {
          companyName: "Unknown",
          jobTitle: "N/A",
        }),
      ),
    ];

    const summary = await processAiProcessedEmailsForUser("user-1");

    expect(applications).toHaveLength(0);
    expect(emails.every((email) => email.applicationId === null)).toBe(true);
    expect(summary.ignored).toBe(1);
    expect(summary.outcomes.NEEDS_REVIEW).toBe(2);
    expect(emails.every((email) =>
      email.extractedData?.applicationMatchOutcome === "NEEDS_REVIEW",
    )).toBe(true);
  });

  it("does not change status for HR, assessment, or other categories", async () => {
    const application = makeApplication(
      "existing-app",
      "user-1",
      "Acme Incorporated",
      "Senior Software Engineer",
      "INTERVIEW",
    );
    applications = [application];
    emails = [
      makeEmail(
        "hr-email",
        "2026-11-01T10:00:00.000Z",
        extraction("HR_COMMUNICATION"),
      ),
      makeEmail(
        "assessment-email",
        "2026-11-02T10:00:00.000Z",
        extraction("ASSESSMENT"),
      ),
      makeEmail(
        "other-email",
        "2026-11-03T10:00:00.000Z",
        extraction("OTHER"),
      ),
    ];

    const summary = await processAiProcessedEmailsForUser("user-1");

    expect(applications).toHaveLength(1);
    expect(application.status).toBe("INTERVIEW");
    expect(emails.every((email) => email.applicationId === application.id)).toBe(
      true,
    );
    expect(summary.statusesUpdated).toBe(0);
  });

  it("is idempotent when the same processed emails are handled again", async () => {
    emails = [
      makeEmail(
        "application-email",
        "2026-11-01T10:00:00.000Z",
        extraction("APPLICATION"),
      ),
    ];

    await processAiProcessedEmailsForUser("user-1");
    await processAiProcessedEmailsForUser("user-1");

    expect(applications).toHaveLength(1);
    expect(mock.saveEmails).toHaveBeenCalledTimes(1);
    expect(emails[0].extractedData).toMatchObject({
      applicationMatchOutcome: "NEW_APPLICATION",
    });
  });

  it("creates an application from an explicit application confirmation", async () => {
    const email = makeEmail(
      "application-confirmation",
      "2026-11-01T10:00:00.000Z",
      extraction("APPLICATION", {
        eventType: "APPLICATION_RECEIVED",
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        applicationReferenceId: "APP-101",
      }),
    );
    emails = [email];

    const summary = await processAiProcessedEmailsForUser("user-1");

    expect(applications).toHaveLength(1);
    expect(email.applicationId).toBe(applications[0].id);
    expect(email.extractedData).toMatchObject({
      applicationMatchOutcome: "NEW_APPLICATION",
    });
    expect(summary.outcomes.NEW_APPLICATION).toBe(1);
  });

  it("creates an application from role-specific recruiter HR outreach", async () => {
    const email = makeEmail(
      "recruiter-outreach",
      "2026-11-01T10:00:00.000Z",
      extraction("HR_COMMUNICATION", {
        eventType: "HR_UPDATE",
        companyName: "VR Della IT Services Pvt Ltd",
        jobTitle: "Java Full Stack Developer",
        summary:
          "Recruiter requested an updated resume and asked the candidate to confirm interest in a specific role.",
      }),
    );
    emails = [email];

    const summary = await processAiProcessedEmailsForUser("user-1");

    expect(applications).toHaveLength(1);
    expect(email.applicationId).toBe(applications[0].id);
    expect(applications[0]).toMatchObject({
      companyName: "VR Della IT Services Pvt Ltd",
      jobTitle: "Java Full Stack Developer",
      status: "APPLIED",
      appliedAt: null,
    });
    expect(email.extractedData).toMatchObject({
      applicationMatchOutcome: "NEW_APPLICATION",
    });
    expect(summary.applicationsCreated).toBe(1);
  });

  it("matches interview invitations and cleared notices to the same application", async () => {
    const applicationEmail = makeEmail(
      "application-confirmation",
      "2026-11-01T10:00:00.000Z",
      extraction("APPLICATION", {
        eventType: "APPLICATION_RECEIVED",
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        applicationReferenceId: "APP-202",
      }),
    );
    const invitation = makeEmail(
      "interview-invitation",
      "2026-11-02T10:00:00.000Z",
      extraction("INTERVIEW", {
        eventType: "INTERVIEW_SCHEDULED",
        companyName: "ANC TECHNOLOGIES",
        jobTitle: "Java Developer - Backend",
      }),
    );
    const cleared = makeEmail(
      "interview-cleared",
      "2026-11-03T10:00:00.000Z",
      extraction("INTERVIEW", {
        eventType: "INTERVIEW_CLEARED",
        companyName: "ANC Technologies",
        jobTitle: null,
        applicationReferenceId: "APP-202",
      }),
    );
    emails = [applicationEmail, invitation, cleared];

    await processAiProcessedEmailsForUser("user-1");

    expect(applications).toHaveLength(1);
    expect(invitation.applicationId).toBe(applicationEmail.applicationId);
    expect(cleared.applicationId).toBe(applicationEmail.applicationId);
    expect(invitation.extractedData).toMatchObject({
      applicationMatchOutcome: "MATCHED",
    });
    expect(cleared.extractedData).toMatchObject({
      applicationMatchOutcome: "MATCHED",
    });
  });

  it("matches an HR update without a job title through its associated Gmail thread", async () => {
    const application = makeApplication(
      "anc-java",
      "user-1",
      "ANC Technologies",
      "Java Developer",
      "INTERVIEW",
    );
    const priorEmail = makeEmail(
      "prior-email",
      "2026-11-01T10:00:00.000Z",
      extraction("APPLICATION", {
        applicationReferenceId: "APP-303",
      }),
    );
    priorEmail.applicationId = application.id;
    priorEmail.matchingPending = false;
    const hrUpdate = makeEmail(
      "hr-update",
      "2026-11-05T10:00:00.000Z",
      extraction("HR_COMMUNICATION", {
        eventType: "HR_UPDATE",
        companyName: null,
        jobTitle: null,
      }),
    );
    hrUpdate.gmailThreadId = priorEmail.gmailThreadId;
    applications = [application];
    emails = [priorEmail, hrUpdate];

    await processAiProcessedEmailsForUser("user-1");

    expect(hrUpdate.applicationId).toBe(application.id);
    expect(hrUpdate.extractedData).toMatchObject({
      applicationMatchOutcome: "MATCHED",
    });
  });

  it("creates separate applications for different openings at the same company", async () => {
    const javaRole = makeEmail(
      "java-role",
      "2026-11-01T10:00:00.000Z",
      extraction("APPLICATION", {
        eventType: "APPLICATION_RECEIVED",
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
      }),
    );
    const analystRole = makeEmail(
      "analyst-role",
      "2026-11-02T10:00:00.000Z",
      extraction("APPLICATION", {
        eventType: "APPLICATION_RECEIVED",
        companyName: "ANC TECHNOLOGIES",
        jobTitle: "Data Analyst",
      }),
    );
    emails = [javaRole, analystRole];

    await processAiProcessedEmailsForUser("user-1");

    expect(applications).toHaveLength(2);
    expect(javaRole.applicationId).not.toBe(analystRole.applicationId);
  });

  it("matches by an exact application reference when title data is missing", async () => {
    const application = makeApplication(
      "anc-java",
      "user-1",
      "ANC Technologies",
      "Java Developer",
      "APPLIED",
    );
    const referenceEmail = makeEmail(
      "reference-email",
      "2026-11-01T10:00:00.000Z",
      extraction("APPLICATION", {
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        applicationReferenceId: "APP-404",
      }),
    );
    referenceEmail.applicationId = application.id;
    const followUp = makeEmail(
      "follow-up",
      "2026-11-02T10:00:00.000Z",
      extraction("HR_COMMUNICATION", {
        eventType: "HR_UPDATE",
        companyName: null,
        jobTitle: null,
        applicationReferenceId: "APP-404",
      }),
    );
    applications = [application];
    emails = [referenceEmail, followUp];

    const summary = await processAiProcessedEmailsForUser("user-1");

    expect(followUp.applicationId).toBe(application.id);
    expect(followUp.extractedData).toMatchObject({
      applicationMatchOutcome: "MATCHED",
    });
    expect(summary.outcomes.MATCHED).toBe(2);
  });

  it("leaves emails with identifiers pointing to conflicting applications for review", async () => {
    const javaApplication = makeApplication(
      "anc-java",
      "user-1",
      "ANC Technologies",
      "Java Developer",
      "APPLIED",
    );
    const analystApplication = makeApplication(
      "anc-analyst",
      "user-1",
      "ANC Technologies",
      "Data Analyst",
      "APPLIED",
    );
    const javaReference = makeEmail(
      "java-reference",
      "2026-11-01T10:00:00.000Z",
      extraction("APPLICATION", {
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        jobReferenceId: "JOB-501",
      }),
    );
    javaReference.applicationId = javaApplication.id;
    const analystReference = makeEmail(
      "analyst-reference",
      "2026-11-01T11:00:00.000Z",
      extraction("APPLICATION", {
        companyName: "ANC Technologies",
        jobTitle: "Data Analyst",
        applicationReferenceId: "APP-502",
      }),
    );
    analystReference.applicationId = analystApplication.id;
    const conflictingEmail = makeEmail(
      "conflicting-email",
      "2026-11-02T10:00:00.000Z",
      extraction("HR_COMMUNICATION", {
        eventType: "HR_UPDATE",
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
        jobReferenceId: "JOB-501",
        applicationReferenceId: "APP-502",
      }),
    );
    applications = [javaApplication, analystApplication];
    emails = [javaReference, analystReference, conflictingEmail];

    const summary = await processAiProcessedEmailsForUser("user-1");

    expect(conflictingEmail.applicationId).toBeNull();
    expect(conflictingEmail.extractedData).toMatchObject({
      applicationMatchOutcome: "NEEDS_REVIEW",
    });
    expect(summary.outcomes.NEEDS_REVIEW).toBe(1);
  });

  it("leaves an email needing review when multiple openings are equally plausible", async () => {
    applications = [
      makeApplication("java-opening-1", "user-1", "ANC Technologies", "Java Developer", "APPLIED"),
      makeApplication("java-opening-2", "user-1", "ANC Technologies", "Java Developer", "INTERVIEW"),
    ];
    const email = makeEmail(
      "ambiguous-email",
      "2026-11-02T10:00:00.000Z",
      extraction("HR_COMMUNICATION", {
        eventType: "HR_UPDATE",
        companyName: "ANC Technologies",
        jobTitle: "Java Developer",
      }),
    );
    emails = [email];

    const summary = await processAiProcessedEmailsForUser("user-1");

    expect(email.applicationId).toBeNull();
    expect(email.extractedData).toMatchObject({
      applicationMatchOutcome: "NEEDS_REVIEW",
    });
    expect(summary.outcomes.NEEDS_REVIEW).toBe(1);
    expect(applications).toHaveLength(2);
  });

  it("never matches by company alone and does not create an HR application", async () => {
    applications = [
      makeApplication("anc-java", "user-1", "ANC Technologies", "Java Developer", "APPLIED"),
    ];
    const email = makeEmail(
      "company-only-email",
      "2026-11-02T10:00:00.000Z",
      extraction("HR_COMMUNICATION", {
        eventType: "HR_UPDATE",
        companyName: "ANC Technologies",
        jobTitle: null,
      }),
    );
    emails = [email];

    const summary = await processAiProcessedEmailsForUser("user-1");

    expect(email.applicationId).toBeNull();
    expect(email.extractedData).toMatchObject({
      applicationMatchOutcome: "NEEDS_REVIEW",
    });
    expect(applications).toHaveLength(1);
    expect(summary.applicationsCreated).toBe(0);
  });

  it("does not automatically associate a job advertisement to a matching application", async () => {
    applications = [
      makeApplication("opening", "user-1", "Acme", "Senior Software Engineer", "APPLIED"),
    ];
    const email = makeEmail(
      "job-advertisement",
      "2026-11-02T10:00:00.000Z",
      extraction("OTHER", { eventType: "OTHER" }),
    );
    emails = [email];

    await processAiProcessedEmailsForUser("user-1");

    expect(email.applicationId).toBeNull();
    expect(email.extractedData?.applicationMatchOutcome).toBe("NEEDS_REVIEW");
    expect(applications[0].status).toBe("APPLIED");
  });

  it("does not reprocess existing review emails when a new email arrives", async () => {
    const existing = makeEmail(
      "existing-review",
      "2026-11-01T10:00:00.000Z",
      extraction("APPLICATION", { applicationMatchOutcome: "NEEDS_REVIEW" }),
    );
    existing.matchingPending = false;
    const incoming = makeEmail(
      "incoming",
      "2026-11-02T10:00:00.000Z",
      extraction("APPLICATION", { eventType: "APPLICATION_RECEIVED" }),
    );
    emails = [existing, incoming];

    const summary = await processAiProcessedEmailsForUser("user-1");

    expect(summary.examined).toBe(1);
    expect(existing.applicationId).toBeNull();
    expect(existing.extractedData?.applicationMatchOutcome).toBe("NEEDS_REVIEW");
    expect(incoming.applicationId).toBe(applications[0].id);
  });

  it("processes pending matching work in bounded batches", async () => {
    emails = Array.from({ length: 11 }, (_, index) =>
      makeEmail(`email-${index}`, "2026-11-01T10:00:00.000Z",
        extraction("APPLICATION", { eventType: "APPLICATION_RECEIVED" })),
    );

    const summary = await processAiProcessedEmailsForUser("user-1");

    expect(summary.examined).toBe(11);
    expect(applications).toHaveLength(1);
    expect(emails.every((email) => !email.matchingPending)).toBe(true);
    expect(mock.findEmails).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-1", matchingPending: true },
      take: 10,
    }));
  });

  it("requests only matching application candidates for a large history", async () => {
    applications = Array.from({ length: 15_000 }, (_, index) =>
      makeApplication(`app-${index}`, "user-1", `Company ${index}`, "Developer", "APPLIED"),
    );
    const email = makeEmail(
      "incoming",
      "2026-11-02T10:00:00.000Z",
      extraction("INTERVIEW", {
        eventType: "INTERVIEW_SCHEDULED",
        companyName: "Company 42",
        jobTitle: "Developer",
      }),
    );
    emails = [email];

    await processAiProcessedEmailsForUser("user-1");

    expect(email.applicationId).toBe("app-42");
    expect(mock.candidateCount).toHaveBeenCalledWith(1);
    expect(mock.candidateCondition).toHaveBeenCalledWith(
      "application",
      expect.stringContaining("application.normalized_company_name"),
      { company: "company 42", title: "developer" },
    );
    expect(mock.findApplications).not.toHaveBeenCalled();
  });

  it("uses the same Unicode normalization for saved applications and candidate lookup", async () => {
    const application = makeApplication(
      "unicode-opening", "user-1", "İNFO", "Engineer - Backend", "APPLIED",
    );
    const email = makeEmail(
      "unicode-email",
      "2026-11-02T10:00:00.000Z",
      extraction("INTERVIEW", {
        eventType: "INTERVIEW_SCHEDULED",
        companyName: "i nfo",
        jobTitle: "Engineer",
      }),
    );
    applications = [application];
    emails = [email];

    await processAiProcessedEmailsForUser("user-1");

    expect(email.applicationId).toBe(application.id);
    expect(application.status).toBe("INTERVIEW");
  });

  it("uses updated candidate keys when application details change", async () => {
    const application = makeApplication(
      "edited-opening", "user-1", "Old Company", "Old Role", "APPLIED",
    );
    applications = [application];
    application.companyName = "New Company Inc.";
    application.jobTitle = "Developer - Backend";
    await applicationRepository.save(application);
    const email = makeEmail(
      "edited-opening-email",
      "2026-11-02T10:00:00.000Z",
      extraction("INTERVIEW", {
        eventType: "INTERVIEW_SCHEDULED",
        companyName: "New Company",
        jobTitle: "Developer",
      }),
    );
    emails = [email];

    await processAiProcessedEmailsForUser("user-1");

    expect(email.applicationId).toBe(application.id);
  });

  it("matches an older reference with non-ASCII surrounding whitespace", async () => {
    const application = makeApplication(
      "reference-opening", "user-1", "Acme", "Senior Software Engineer", "APPLIED",
    );
    const prior = makeEmail(
      "prior-reference",
      "2026-11-01T10:00:00.000Z",
      extraction("APPLICATION", { applicationReferenceId: "\u00a0APP-123\n" }),
    );
    prior.applicationId = application.id;
    prior.matchingPending = false;
    const followup = makeEmail(
      "reference-followup",
      "2026-11-02T10:00:00.000Z",
      extraction("HR_COMMUNICATION", {
        eventType: "HR_UPDATE",
        companyName: null,
        jobTitle: null,
        applicationReferenceId: "APP-123",
      }),
    );
    applications = [application];
    emails = [prior, followup];

    await processAiProcessedEmailsForUser("user-1");

    expect(followup.applicationId).toBe(application.id);
    expect(mock.candidateCondition).toHaveBeenCalledWith(
      "email",
      expect.stringContaining("jobpilot_trim_reference"),
      { applicationReferenceId: "APP-123" },
    );
  });

  it("does not overwrite existing application fields when extraction data is missing", async () => {
    const application = makeApplication(
      "existing-app",
      "user-1",
      "ANC Technologies",
      "Java Developer",
      "INTERVIEW",
    );
    application.source = "Gmail";
    application.notes = "Keep these notes";
    application.appliedAt = new Date("2026-10-01T00:00:00.000Z");
    const email = makeEmail(
      "existing-linked-email",
      "2026-11-02T10:00:00.000Z",
      extraction("HR_COMMUNICATION", {
        eventType: "HR_UPDATE",
        companyName: null,
        jobTitle: null,
      }),
    );
    email.applicationId = application.id;
    applications = [application];
    emails = [email];

    await processAiProcessedEmailsForUser("user-1");

    expect(application).toMatchObject({
      companyName: "ANC Technologies",
      jobTitle: "Java Developer",
      status: "INTERVIEW",
      source: "Gmail",
      notes: "Keep these notes",
      appliedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
  });
});
