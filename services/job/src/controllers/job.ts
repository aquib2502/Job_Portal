import axios from "axios";
import { AuthenticatedRequest } from "../middlewares/auth.js";
import getBuffer from "../utils/buffer.js";
import { sql } from "../utils/db.js";
import ErrorHandler from "../utils/errorHandler.js";
import { TryCatch } from "../utils/TryCatch.js";
import { applicationStatusUpdateTemplate } from "../tempelete.js";
import { publishToTopic } from "../producer.js";

/* ===================== COMPANY ===================== */

export const createCompany = TryCatch(async (req: AuthenticatedRequest, res) => {
  const user = req.user;

  if (!user) throw new ErrorHandler(401, "Authentication required");
  if (user.role !== "recruiter")
    throw new ErrorHandler(403, "Forbidden: Only recruiter can create a company");

  const { name, description, website } = req.body;

  if (!name || !description || !website)
    throw new ErrorHandler(400, "All the fields required");

  const existingCompanies =
    await sql`SELECT company_id FROM companies WHERE name = ${name}`;

  if (existingCompanies.length > 0)
    throw new ErrorHandler(409, `A company with the name ${name} already exists`);

  const file = req.file;
  if (!file) throw new ErrorHandler(400, "Company Logo file is required");

  const fileBuffer = getBuffer(file);
  if (!fileBuffer?.content)
    throw new ErrorHandler(500, "Failed to create file buffer");

  const { data } = await axios.post(
    `${process.env.UPLOAD_SERVICE}/api/utils/upload`,
    { buffer: fileBuffer.content }
  );

  const [newCompany] = await sql`
    INSERT INTO companies (name, description, website, logo, logo_public_id, recruiter_id)
    VALUES (${name}, ${description}, ${website}, ${data.url}, ${data.public_id}, ${user.user_id})
    RETURNING *
  `;

  res.json({ message: "Company created successfully", company: newCompany });
});

export const deleteCompany = TryCatch(async (req: AuthenticatedRequest, res) => {
  const user = req.user;
  if (!user) throw new ErrorHandler(401, "Authentication required");

  const companyId = Number(req.params.companyId);

  const [company] = await sql`
    SELECT logo_public_id
    FROM companies
    WHERE company_id = ${companyId}
    AND recruiter_id = ${user.user_id}
  `;

  if (!company)
    throw new ErrorHandler(
      404,
      "Company not found or you're not authorized to delete it."
    );

  await sql`DELETE FROM companies WHERE company_id = ${companyId}`;

  res.json({ message: "Company and all associated jobs have been deleted" });
});

/* ===================== JOB ===================== */

export const createJob = TryCatch(async (req: AuthenticatedRequest, res) => {
  const user = req.user;
  if (!user) throw new ErrorHandler(401, "Authentication required");
  if (user.role !== "recruiter")
    throw new ErrorHandler(403, "Forbidden: Only recruiter can create a job");

  const {
    title,
    description,
    salary,
    location,
    role,
    job_type,
    work_location,
    company_id,
    openings,
  } = req.body;

  if (!title || !description || !salary || !location || !role || !openings)
    throw new ErrorHandler(400, "All the fields required");

  const [company] = await sql`
    SELECT company_id
    FROM companies
    WHERE company_id = ${Number(company_id)}
    AND recruiter_id = ${user.user_id}
  `;

  if (!company) throw new ErrorHandler(404, "Company not found");

  const [newJob] = await sql`
    INSERT INTO jobs
    (title, description, salary, location, role, job_type, work_location, company_id, posted_by_recuriter_id, openings)
    VALUES
    (${title}, ${description}, ${salary}, ${location}, ${role}, ${job_type}, ${work_location}, ${Number(company_id)}, ${user.user_id}, ${openings})
    RETURNING *
  `;

  res.json({ message: "Job posted successfully", job: newJob });
});

export const updateJob = TryCatch(async (req: AuthenticatedRequest, res) => {
  const user = req.user;
  if (!user) throw new ErrorHandler(401, "Authentication required");
  if (user.role !== "recruiter")
    throw new ErrorHandler(403, "Forbidden: Only recruiter can update a job");

  const jobId = Number(req.params.jobId);

  const [existingJob] = await sql`
    SELECT posted_by_recuriter_id
    FROM jobs
    WHERE job_id = ${jobId}
  `;

  if (!existingJob) throw new ErrorHandler(404, "Job not found");
  if (existingJob.posted_by_recuriter_id !== user.user_id)
    throw new ErrorHandler(403, "Forbidden");

  const [updatedJob] = await sql`
    UPDATE jobs SET
      title = ${req.body.title},
      description = ${req.body.description},
      salary = ${req.body.salary},
      location = ${req.body.location},
      role = ${req.body.role},
      job_type = ${req.body.job_type},
      work_location = ${req.body.work_location},
      openings = ${req.body.openings},
      is_active = ${req.body.is_active}
    WHERE job_id = ${jobId}
    RETURNING *
  `;

  res.json({ message: "Job updated successfully", job: updatedJob });
});

/* ===================== FETCH ===================== */

export const getAllCompany = TryCatch(async (req: AuthenticatedRequest, res) => {
  const companies = await sql`
    SELECT * FROM companies WHERE recruiter_id = ${req.user!.user_id}
  `;
  res.json(companies);
});

export const getCompanyDetails = TryCatch(async (req, res) => {
  const companyId = Number(req.params.id);

  const [companyData] = await sql`
    SELECT c.*, COALESCE(
      (SELECT json_agg(j.*) FROM jobs j WHERE j.company_id = c.company_id),
      '[]'::json
    ) AS jobs
    FROM companies c
    WHERE c.company_id = ${companyId}
    GROUP BY c.company_id
  `;

  if (!companyData) throw new ErrorHandler(404, "Company not found");
  res.json(companyData);
});

export const getAllActiveJobs = TryCatch(async (req, res) => {
  const { title, location } = req.query as { title?: string; location?: string };

  let query = `
    SELECT j.*, c.name AS company_name, c.logo AS company_logo
    FROM jobs j
    JOIN companies c ON j.company_id = c.company_id
    WHERE j.is_active = true
  `;

  const values: any[] = [];

  if (title) {
    values.push(`%${title}%`);
    query += ` AND j.title ILIKE $${values.length}`;
  }

  if (location) {
    values.push(`%${location}%`);
    query += ` AND j.location ILIKE $${values.length}`;
  }

  query += " ORDER BY j.created_at DESC";

  const jobs = await sql.unsafe(query, values);
  res.json(jobs);
});

export const getSingleJob = TryCatch(async (req, res) => {
  const [job] = await sql`
    SELECT * FROM jobs WHERE job_id = ${Number(req.params.jobId)}
  `;
  res.json(job);
});

/* ===================== APPLICATION ===================== */

export const getAllApplicationForJob = TryCatch(
  async (req: AuthenticatedRequest, res) => {
    const user = req.user;
    if (!user) throw new ErrorHandler(401, "Authentication required");

    const jobId = Number(req.params.jobId);

    const [job] = await sql`
      SELECT posted_by_recuriter_id FROM jobs WHERE job_id = ${jobId}
    `;

    if (!job) throw new ErrorHandler(404, "Job not found");
    if (job.posted_by_recuriter_id !== user.user_id)
      throw new ErrorHandler(403, "Forbidden");

    const applications = await sql`
      SELECT * FROM applications
      WHERE job_id = ${jobId}
      ORDER BY subscribed DESC, applied_at ASC
    `;

    res.json(applications);
  }
);

export const updateApplication = TryCatch(
  async (req: AuthenticatedRequest, res) => {
    const user = req.user;
    if (!user) throw new ErrorHandler(401, "Authentication required");

    const applicationId = Number(req.params.id);

    const [application] = await sql`
      SELECT * FROM applications WHERE application_id = ${applicationId}
    `;

    if (!application)
      throw new ErrorHandler(404, "Application not found");

    const [job] = await sql`
      SELECT posted_by_recuriter_id, title
      FROM jobs
      WHERE job_id = ${application.job_id}
    `;

    if (job.posted_by_recuriter_id !== user.user_id)
      throw new ErrorHandler(403, "Forbidden");

    const [updatedApplication] = await sql`
      UPDATE applications
      SET status = ${req.body.status}
      WHERE application_id = ${applicationId}
      RETURNING *
    `;

    publishToTopic("send-mail", {
      to: application.applicant_email,
      subject: "Application Update - Job portal",
      html: applicationStatusUpdateTemplate(job.title),
    });

    res.json({ message: "Application updated", updatedApplication });
  }
);
