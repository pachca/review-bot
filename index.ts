import wretch from 'wretch'
import { Octokit } from 'octokit'
import type { WebhookEvent } from '@octokit/webhooks-types'
import { expectType } from 'ts-expect'

if (!process.env.GITHUB_ACCESS_TOKEN) throw new Error('Не указан GITHUB_ACCESS_TOKEN')
if (!process.env.GITHUB_OWNER) throw new Error('Не указан GITHUB_OWNER')
if (!process.env.GITHUB_REPO) throw new Error('Не указан GITHUB_REPO')
if (!process.env.GITHUB_USER_LOGIN) throw new Error('Не указан GITHUB_USER_LOGIN')

const octokit = new Octokit({
  auth: process.env.GITHUB_ACCESS_TOKEN,
})
const GITHUB_CONSTANTS = {
  owner: process.env.GITHUB_OWNER,
  repo: process.env.GITHUB_REPO,
  user_login: process.env.GITHUB_USER_LOGIN,
}

if (!process.env.PACHCA_API_ACCESS_TOKEN) throw new Error('Не указан PACHCA_API_ACCESS_TOKEN')
if (!process.env.PACHCA_CHAT_ID) throw new Error('Не указан PACHCA_CHAT_ID')

const pachcaApi = wretch('https://api.pachca.com/api/shared/v1').auth(
  `Bearer ${process.env.PACHCA_API_ACCESS_TOKEN}`
)
const PACHCA_CONTSTANTS = {
  chat_id: process.env.PACHCA_CHAT_ID,
}

// Так выглядит код для облачных функций Яндекс
// https://cloud.yandex.ru/ru/docs/functions/lang/nodejs/handler
// Можно хостить на своем сервере
// Примеры настройки сервера с bun https://bun.sh/docs/api/http
module.exports.handler = async function handler(event: { body: string }) {
  try {
    const webhookEvent = JSON.parse(event.body) as WebhookEvent

    const pachcaThread = await getPachcaThread(webhookEvent)
    if (!pachcaThread) {
      return {
        statusCode: 200,
        body: 'Нет необходимости создавать тред',
      }
    }

    const threadNotificationMessage = await getThreadNotificationMessage(webhookEvent)
    if (!threadNotificationMessage) {
      return {
        statusCode: 200,
        body: 'Нет сообщения для треда',
      }
    }

    await sendThreadMessage(pachcaThread.id, threadNotificationMessage)
    return {
      statusCode: 200,
      body: 'Обновили главное сообщение + отправили сообщение в тред',
    }
  } catch (e) {
    if (e instanceof Response) {
      return {
        statusCode: e.status,
        body: e.statusText,
      }
    }
    if (e instanceof Error) {
      return {
        statusCode: 400,
        body: e.message,
      }
    }
  }
}

async function getPachcaThread(webhookEvent: WebhookEvent) {
  const shouldTriggerUpdates = (() => {
    if ('workflow_run' in webhookEvent) return true
    if ('pull_request' in webhookEvent) {
      return (
        webhookEvent.action === 'opened' ||
        webhookEvent.action === 'closed' ||
        webhookEvent.action === 'edited' ||
        webhookEvent.action === 'reopened' ||
        webhookEvent.action === 'review_requested' ||
        webhookEvent.action === 'review_request_removed' ||
        webhookEvent.action === 'dismissed' ||
        webhookEvent.action === 'submitted'
      )
    }
    return false
  })()
  if (!shouldTriggerUpdates) return

  const pullRequestNumber = (() => {
    if ('workflow_run' in webhookEvent) {
      return webhookEvent.workflow_run?.pull_requests[0]?.number
    }
    if ('pull_request' in webhookEvent) {
      return webhookEvent.pull_request.number
    }
    return
  })()
  if (!pullRequestNumber) return

  const pullRequest = (
    await octokit.rest.pulls.get({
      owner: GITHUB_CONSTANTS.owner,
      repo: GITHUB_CONSTANTS.repo,
      pull_number: pullRequestNumber,
    })
  ).data
  if (!pullRequest) throw new Error('Не удалось запросить pull_request')

  const pachcaCommentInGithub = await octokit.rest.issues
    .listComments({
      owner: GITHUB_CONSTANTS.owner,
      repo: GITHUB_CONSTANTS.repo,
      issue_number: pullRequest.number,
    })
    .then((comments) => comments.data.find((c) => c.user?.login === GITHUB_CONSTANTS.user_login))

  const content = await (async () => {
    const statusText = await (async () => {
      if (pullRequest.merged) {
        return `🎉 Смержен @${pullRequest.merged_by?.login}`
      }
      if (pullRequest.closed_at) return '❌ Закрыт'
      if (pullRequest.state === 'closed') return '🤔 Закрыт?'
      expectType<'open'>(pullRequest.state)

      const reviews = (
        await octokit.rest.pulls.listReviews({
          owner: GITHUB_CONSTANTS.owner,
          repo: GITHUB_CONSTANTS.repo,
          pull_number: pullRequest.number,
        })
      ).data.filter((r) => r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED')

      const requestedReviewers = (
        await octokit.rest.pulls.listRequestedReviewers({
          owner: GITHUB_CONSTANTS.owner,
          repo: GITHUB_CONSTANTS.repo,
          pull_number: pullRequest.number,
        })
      ).data.users

      const userToReviewMap = reviews.reduce<{
        [userLogin: string]: 'CHANGES_REQUESTED' | 'APPROVED'
      }>((acc, review) => {
        if (!review.user?.login) return acc
        if (review.state !== 'CHANGES_REQUESTED' && review.state !== 'APPROVED') return acc
        acc[review.user.login] = review.state
        return acc
      }, {})

      const reviewsMap = Object.keys(userToReviewMap).reduce<{
        CHANGES_REQUESTED: string[]
        APPROVED: string[]
      }>(
        (acc, userLogin) => {
          const state = userToReviewMap[userLogin]
          if (!state) return acc
          if (state === 'CHANGES_REQUESTED') {
            return { ...acc, CHANGES_REQUESTED: [...acc.CHANGES_REQUESTED, userLogin] }
          }
          if (state === 'APPROVED') {
            return { ...acc, APPROVED: [...acc.APPROVED, userLogin] }
          }
          return acc
        },
        { CHANGES_REQUESTED: [], APPROVED: [] }
      )

      if (pullRequest.draft) {
        return '🏗️ В работе'
      }
      if (requestedReviewers.length) {
        return `👀 Ожидает ревью от ${requestedReviewers.map((r) => `@${r.login}`).join(' ')}`
      }

      if (!reviews.length) {
        return '🧑‍🍼 Ожидает первого ревью'
      }

      if (reviewsMap.CHANGES_REQUESTED.length) {
        return `✏️ ${reviewsMap.CHANGES_REQUESTED.map((l) => `@${l}`).join(' ')} ${
          reviewsMap.CHANGES_REQUESTED.length === 1 ? 'запросил' : 'запросили'
        } правки`
      }
      if (reviewsMap.APPROVED.length) {
        return `👌 ${reviewsMap.APPROVED.map((l) => `@${l}`).join(' ')} ${
          reviewsMap.APPROVED.length === 1 ? 'заапрувил' : 'заапрувили'
        } правки`
      }

      return '🔴 Unknown'
    })()

    return `${pullRequest.title} [(#${pullRequest.number})](https://app.graphite.dev/github/pr/pachca/web/${pullRequest.number})
  ↳ **Автор:** @${pullRequest.user.login}
  ↳ **Статус:** ${statusText}`
  })()

  const pachcaMessage = await (async () => {
    if (!pachcaCommentInGithub) {
      return pachcaApi
        .url('/messages')
        .json({
          message: {
            entity_type: 'discussion',
            entity_id: PACHCA_CONTSTANTS.chat_id,
            content,
          },
        })
        .post()
        .json<{ data: { id: number; thread: null | { id: number; chat_id: number } } }>()
    } else {
      const messageId = pachcaCommentInGithub.body?.match(/message=(.+)&/)?.[1]
      if (!messageId) throw new Error('Не найден id сообщения в Пачке')

      return pachcaApi
        .url(`/messages/${messageId}`)
        .json({
          message: {
            content,
            files: [],
          },
        })
        .put()
        .json<{ data: { id: number; thread: null | { id: number; chat_id: number } } }>()
    }
  })()

  if (!pachcaCommentInGithub) {
    await octokit.rest.issues.createComment({
      owner: GITHUB_CONSTANTS.owner,
      repo: GITHUB_CONSTANTS.repo,
      issue_number: pullRequest.number,
      body: `[Обсуждение в Пачке](https://app.pachca.com/chats/${PACHCA_CONTSTANTS.chat_id}?message=${pachcaMessage.data.id}&thread_message_id=${pachcaMessage.data.id})`,
    })
  }
  const pachcaThread = await (async () => {
    if (pachcaMessage.data.thread?.id) return pachcaMessage.data.thread
    return pachcaApi
      .url(`/messages/${pachcaMessage.data.id}/thread`)
      .post()
      .json<{ data: { id: number; chat_id: number } }>()
      .then((thread) => ({ id: thread.data.id, chat_id: thread.data.chat_id }))
  })()

  return pachcaThread
}

async function getThreadNotificationMessage(webhookEvent: WebhookEvent) {
  if ('pull_request' in webhookEvent) {
    if (webhookEvent.action === 'opened') {
      return `🆕 @${webhookEvent.sender.login} создал PR`
    }

    if (webhookEvent.action === 'closed') {
      if (webhookEvent.pull_request.merged) {
        return `🎉 @${webhookEvent.sender.login} смержилPR`
      }
      return `🙅‍♂️ @${webhookEvent.sender.login} закрыл PR`
    }

    if (webhookEvent.action === 'reopened') {
      return `✌️ @${webhookEvent.sender.login} повторно открыл PR`
    }

    if (webhookEvent.action === 'edited') {
      if ('body' in webhookEvent.changes) {
        return `🏗️ @${webhookEvent.sender.login} отредактировал описание PR`
      }
      if ('title' in webhookEvent.changes) {
        return `🏗️ @${webhookEvent.sender.login} отредактировал заголовок
  ~~${webhookEvent.changes.title?.from}~~ -> ${webhookEvent.pull_request.title}`
      }
      if ('base' in webhookEvent.changes) {
        return `🏗️ @${webhookEvent.sender.login} сделал rebase`
      }

      return
    }

    if (webhookEvent.action === 'review_requested') {
      if ('requested_reviewer' in webhookEvent) {
        if (webhookEvent.sender.login === webhookEvent.requested_reviewer.login) {
          return `📣 @${webhookEvent.sender.login} отметил себя ревьюером`
        }

        return `📣 @${webhookEvent.sender.login} запросил ревью от @${webhookEvent.requested_reviewer.login}`
      }
    }

    if (webhookEvent.action === 'review_request_removed') {
      if ('requested_reviewer' in webhookEvent) {
        if (webhookEvent.sender.login === webhookEvent.requested_reviewer.login) {
          return `🦵 @${webhookEvent.sender.login} исключил себя из ревью`
        }

        return `🦵 @${webhookEvent.sender.login} исключил из ревью @${webhookEvent.requested_reviewer.login}`
      }
    }

    if (webhookEvent.action === 'submitted') {
      if (webhookEvent.review.state === 'dismissed') {
        return `❌ @${webhookEvent.sender.login} отклонил ревью @${webhookEvent.review.user.login}`
      }

      if (webhookEvent.review.state === 'commented') {
        return
      }

      if (webhookEvent.review.state === 'approved') {
        return `👏 @${webhookEvent.sender.login} заапрувил`
      }

      if (webhookEvent.review.state === 'changes_requested') {
        return `✏️ @${webhookEvent.sender.login} запросил правки`
      }

      return `⚠️ неизвестное событие: ${webhookEvent.review.state}`
    }
    return
  }

  if ('workflow_run' in webhookEvent && webhookEvent.workflow_run) {
    if (webhookEvent.workflow_run.conclusion === 'failure') {
      const failedJobsText = getFailedJobsText({
        run_id: webhookEvent.workflow_run.id,
        attempt_number: webhookEvent.workflow_run.run_attempt,
      })

      return `❤️‍🩹 [Ошибка ${webhookEvent.workflow_run.name}](${webhookEvent.workflow_run.html_url}) - [#${webhookEvent.workflow_run.pull_requests[0]?.number}](https://app.graphite.dev/github/pr/pachca/web/${webhookEvent.workflow_run.pull_requests[0]?.number}) @${webhookEvent.sender.login}${failedJobsText}`
    }

    return undefined
  }

  throw new Error(`Низвестное событие`)
}

async function getFailedJobsText({
  run_id,
  attempt_number,
}: {
  run_id: number
  attempt_number: number
}) {
  const jobs = (
    await octokit.rest.actions.listJobsForWorkflowRunAttempt({
      owner: GITHUB_CONSTANTS.owner,
      repo: GITHUB_CONSTANTS.repo,
      run_id,
      attempt_number,
    })
  ).data.jobs

  jobs.reduce<string>((acc, j) => {
    if (j.conclusion !== 'failure') return acc

    const stepsPreviewText = j.steps?.slice(0).reduce<string>((acc2, step, index, all) => {
      if (step.conclusion === 'failure' || step.conclusion === 'cancelled') {
        const stepsToPrint = [all[index - 1], all[index], all[index + 1]].filter(Boolean)
        all.splice(1) // Аналог раннего return для reduce
        return (
          acc2 +
          stepsToPrint.map((s) => {
            const statusSymbol = (() => {
              if (s.conclusion === 'success') return '👌'
              if (s.conclusion === 'skipped') return '🔘'
              if (s.conclusion === 'failure') return '❌'
              if (s.conclusion === 'cancelled') return '🚫'
              return s.conclusion
            })()

            const secondsDiff =
              s.completed_at && s.started_at
                ? (new Date(s.completed_at).getTime() - new Date(s.started_at).getTime()) / 1_000
                : ''

            return `\n${statusSymbol} ${s.name}${secondsDiff ? ' ' + secondsDiff + 'сек' : ''}`
          })
        )
      }
      return acc2
    }, '')

    return (
      acc +
      `\n  ↳ [${j.name}](${j.html_url})${
        stepsPreviewText
          ? `

\`\`\`bash
${stepsPreviewText.substring(1)}
\`\`\``
          : ''
      }`
    )
  }, '')
}

async function sendThreadMessage(threadId: number, content: string) {
  await pachcaApi
    .url('/messages')
    .json({
      message: {
        entity_type: 'thread',
        entity_id: threadId,
        content,
      },
    })
    .post()
    .json<{ data: { id: number; thread: null | { id: number; chat_id: number } } }>()
}
