import * as core from '@actions/core'
import * as github from '@actions/github'
import {Octokit} from '@octokit/rest'
import {Audit} from './audit'
import {IssueOption} from './interface'
import * as issue from './issue'
import * as pr from './pr'
import * as workdir from './workdir'
import {Context} from '@actions/github/lib/context'

async function getExistingIssue(
  octokit: Octokit,
  context: Context
): Promise<Octokit.IssuesListForRepoResponseItem | undefined> {
  const {data: issues} = await octokit.issues.listForRepo({
    ...context.repo,
    state: 'open'
  })

  return issues.filter(i => i.title === core.getInput('issue_title')).shift()
}

export async function run(): Promise<void> {
  try {
    // move to working directory
    const workingDirectory = core.getInput('working_directory')
    if (workingDirectory) {
      if (!workdir.isValid(workingDirectory)) {
        throw new Error('Invalid input: working_directory')
      }
      process.chdir(workingDirectory)
    }
    core.info(`Current working directory: ${process.cwd()}`)

    // get audit-level
    const auditLevel = core.getInput('audit_level', {required: true})
    if (!['critical', 'high', 'moderate', 'low'].includes(auditLevel)) {
      throw new Error('Invalid input: audit_level')
    }

    // run `npm audit`
    const audit = new Audit()
    audit.run(auditLevel)
    core.info(audit.stdout)

    if (audit.foundVulnerability()) {
      // vulnerabilities are found

      // get GitHub information
      const ctx = JSON.parse(core.getInput('github_context'))
      const token: string = core.getInput('github_token', {required: true})
      const octokit = new Octokit({
        auth: token
      })

      if (ctx.event_name === 'pull_request') {
        await pr.createComment(
          token,
          github.context.repo.owner,
          github.context.repo.repo,
          ctx.event.number,
          audit.strippedStdout()
        )
        core.setFailed('This repo has some vulnerabilities')
        return
      } else {
        core.debug('open an issue')
        // remove control characters and create a code block
        const issueBody = audit.strippedStdout()
        const option: IssueOption = issue.getIssueOption(issueBody)

        const existingIssue =
          core.getInput('dedupe_issues') === 'true'
            ? await getExistingIssue(octokit, github.context)
            : undefined

        if (existingIssue !== undefined) {
          const {data: createdComment} = await octokit.issues.createComment({
            ...github.context.repo,
            issue_number: existingIssue.number, // eslint-disable-line @typescript-eslint/camelcase
            body: option.body
          })
          core.debug(`comment ${createdComment.url}`)
        } else {
          const {
            data: createdIssue
          }: Octokit.Response<Octokit.IssuesCreateResponse> = await octokit.issues.create(
            {
              ...github.context.repo,
              ...option
            }
          )
          core.debug(`#${createdIssue.number}`)
        }
        core.setFailed('This repo has some vulnerabilities')
      }
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
