/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { DocGenerationStep, docScheme, getFileSummaryPercentage, Mode } from '../constants'
import { getLogger } from '../../shared/logger/logger'
// eslint-disable-next-line no-restricted-imports
import * as fs from 'fs'

import {
    CurrentWsFolders,
    NewFileInfo,
    NewFileZipContents,
    SessionState,
    SessionStateAction,
    SessionStateConfig,
} from '../types'
import {
    ContentLengthError,
    NoChangeRequiredException,
    PromptRefusalException,
    PromptTooVagueError,
    PromptUnrelatedError,
    ReadmeTooLargeError,
    ReadmeUpdateTooLargeError,
    WorkspaceEmptyError,
} from '../errors'
import { ApiClientError, ApiServiceError } from '../../amazonqFeatureDev/errors'
import { DocMessenger } from '../messenger'
import {
    BaseCodeGenState,
    BaseMessenger,
    BasePrepareCodeGenState,
    CreateNextStateParams,
} from '../../amazonq/session/sessionState'
import {
    getDeletedFileInfos,
    prepareRepoData,
    PrepareRepoDataOptions,
    registerNewFiles,
} from '../../amazonq/util/files'
import { LlmError } from '../../amazonq/errors'
import { VirtualFileSystem } from '../../shared/virtualFilesystem'

import globals from '../../shared/extensionGlobals'
import { i18n } from '../../shared/i18n-helper'

import { CodeReference } from '../../amazonq/webview/ui/connector'

import { CodeGenerationStatus, DeletedFileInfo } from '../../amazonq/commons/types'

import { ToolkitError } from '../../shared/errors'
// eslint-disable-next-line no-restricted-imports
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { AmazonqCreateUpload, Span } from '../../shared/telemetry'

type CliProcessCodeGenerationResult = {
    codeGenerationRemainingIterationCount: number
    codeGenerationTotalIterationCount: number
    codeGenerationStatus: CodeGenerationStatus
    data: {
        newFileContents: NewFileZipContents[]
        deletedFiles: string[]
        references: CodeReference[]
    }
}

export class DocCodeGenPocState extends BaseCodeGenState {
    private qChatProcess: ChildProcessWithoutNullStreams | undefined
    private pollCountInner = 360
    private requestDelayInner = 5000

    protected handleProgress(messenger: DocMessenger, action: SessionStateAction, detail?: string): void {
        if (detail) {
            const progress = getFileSummaryPercentage(detail)
            messenger.sendDocProgress(
                this.tabID,
                progress === 100 ? DocGenerationStep.GENERATING_ARTIFACTS : DocGenerationStep.SUMMARIZING_FILES,
                progress,
                action.mode
            )
        }
    }

    protected getScheme(): string {
        return docScheme
    }

    protected getTimeoutErrorCode(): string {
        return 'DocGenerationTimeout'
    }

    protected handleGenerationComplete(
        messenger: DocMessenger,
        newFileInfo: NewFileInfo[],
        action: SessionStateAction
    ): void {
        messenger.sendDocProgress(this.tabID, DocGenerationStep.GENERATING_ARTIFACTS + 1, 100, action.mode)
    }

    protected handleError(messenger: DocMessenger, codegenResult: any): Error {
        // eslint-disable-next-line unicorn/no-null
        messenger.sendUpdatePromptProgress(this.tabID, null)

        switch (true) {
            case codegenResult.codeGenerationStatusDetail?.includes('README_TOO_LARGE'): {
                return new ReadmeTooLargeError()
            }
            case codegenResult.codeGenerationStatusDetail?.includes('README_UPDATE_TOO_LARGE'): {
                return new ReadmeUpdateTooLargeError(codegenResult.codeGenerationRemainingIterationCount || 0)
            }
            case codegenResult.codeGenerationStatusDetail?.includes('WORKSPACE_TOO_LARGE'): {
                return new ContentLengthError()
            }
            case codegenResult.codeGenerationStatusDetail?.includes('WORKSPACE_EMPTY'): {
                return new WorkspaceEmptyError()
            }
            case codegenResult.codeGenerationStatusDetail?.includes('PROMPT_UNRELATED'): {
                return new PromptUnrelatedError(codegenResult.codeGenerationRemainingIterationCount || 0)
            }
            case codegenResult.codeGenerationStatusDetail?.includes('PROMPT_TOO_VAGUE'): {
                return new PromptTooVagueError(codegenResult.codeGenerationRemainingIterationCount || 0)
            }
            case codegenResult.codeGenerationStatusDetail?.includes('PROMPT_REFUSAL'): {
                return new PromptRefusalException(codegenResult.codeGenerationRemainingIterationCount || 0)
            }
            case codegenResult.codeGenerationStatusDetail?.includes('Guardrails'): {
                return new ApiClientError(
                    i18n('AWS.amazonq.doc.error.docGen.default'),
                    'GetTaskAssistCodeGeneration',
                    'GuardrailsException',
                    400
                )
            }
            case codegenResult.codeGenerationStatusDetail?.includes('EmptyPatch'): {
                if (codegenResult.codeGenerationStatusDetail?.includes('NO_CHANGE_REQUIRED')) {
                    return new NoChangeRequiredException()
                }

                return new LlmError(i18n('AWS.amazonq.doc.error.docGen.default'), {
                    code: 'EmptyPatchException',
                })
            }
            case codegenResult.codeGenerationStatusDetail?.includes('Throttling'): {
                return new ApiClientError(
                    i18n('AWS.amazonq.featureDev.error.throttling'),
                    'GetTaskAssistCodeGeneration',
                    'ThrottlingException',
                    429
                )
            }
            default: {
                return new ApiServiceError(
                    i18n('AWS.amazonq.doc.error.docGen.default'),
                    'GetTaskAssistCodeGeneration',
                    'UnknownException',
                    500
                )
            }
        }
    }

    public override async generateCode({
        messenger,
        fs,
        codeGenerationId,
        telemetry: telemetry,
        workspaceFolders,
        action,
    }: {
        messenger: BaseMessenger
        fs: VirtualFileSystem
        codeGenerationId: string
        telemetry: any
        workspaceFolders: CurrentWsFolders
        action: SessionStateAction
    }): Promise<{
        newFiles: NewFileInfo[]
        deletedFiles: DeletedFileInfo[]
        references: CodeReference[]
        codeGenerationRemainingIterationCount?: number
        codeGenerationTotalIterationCount?: number
    }> {
        const docMessanger = messenger as DocMessenger

        let codeGenerationRemainingIterationCount = undefined
        let codeGenerationTotalIterationCount = undefined
        for (
            let pollingIteration = 0;
            pollingIteration < this.pollCountInner && !this.isCancellationRequested;
            ++pollingIteration
        ) {
            const codegenResult = await this.getCliProcessCodeGenerationResult()

            codeGenerationRemainingIterationCount = codegenResult.codeGenerationRemainingIterationCount
            codeGenerationTotalIterationCount = codegenResult.codeGenerationTotalIterationCount

            getLogger().debug(`Codegen response: %O`, codegenResult)
            telemetry.setCodeGenerationResult(codegenResult.codeGenerationStatus)

            switch (codegenResult.codeGenerationStatus as CodeGenerationStatus) {
                case CodeGenerationStatus.COMPLETE: {
                    const { newFileContents, deletedFiles, references } = codegenResult.data

                    const newFileInfo = registerNewFiles(
                        fs,
                        newFileContents,
                        this.uploadId,
                        workspaceFolders,
                        this.conversationId,
                        this.getScheme()
                    )
                    telemetry.setNumberOfFilesGenerated(newFileInfo.length)
                    this.handleGenerationComplete(docMessanger, newFileInfo, action)

                    return {
                        newFiles: newFileInfo,
                        deletedFiles: getDeletedFileInfos(deletedFiles, workspaceFolders),
                        references,
                        codeGenerationRemainingIterationCount,
                        codeGenerationTotalIterationCount,
                    }
                }
                case CodeGenerationStatus.PREDICT_READY:
                case CodeGenerationStatus.IN_PROGRESS: {
                    // if (codegenResult.codeGenerationStatusDetail) {
                    //     this.handleProgress(docMessanger, action, codegenResult.codeGenerationStatusDetail)
                    // }
                    await new Promise((f) => globals.clock.setTimeout(f, this.requestDelayInner))
                    break
                }
                case CodeGenerationStatus.PREDICT_FAILED:
                case CodeGenerationStatus.DEBATE_FAILED:
                case CodeGenerationStatus.FAILED: {
                    throw this.handleError(docMessanger, codegenResult)
                }
                default: {
                    const errorMessage = `Unknown status: ${codegenResult.codeGenerationStatus}\n`
                    throw new ToolkitError(errorMessage, { code: 'UnknownCodeGenError' })
                }
            }
        }

        await this.killCliProcess()

        if (!this.isCancellationRequested) {
            const errorMessage = i18n('AWS.amazonq.featureDev.error.codeGen.timeout')
            throw new ToolkitError(errorMessage, { code: this.getTimeoutErrorCode() })
        }

        return {
            newFiles: [],
            deletedFiles: [],
            references: [],
            codeGenerationRemainingIterationCount: codeGenerationRemainingIterationCount,
            codeGenerationTotalIterationCount: codeGenerationTotalIterationCount,
        }
    }

    protected async startCodeGeneration(action: SessionStateAction, codeGenerationId: string): Promise<void> {
        if (!action.tokenSource?.token.isCancellationRequested) {
            action.messenger.sendDocProgress(this.tabID, DocGenerationStep.SUMMARIZING_FILES, 0, action.mode as Mode)
        }

        // await this.config.proxyClient.startCodeGeneration(
        //     this.config.conversationId,
        //     this.config.uploadId,
        //     action.msg,
        //     Intent.DOC,
        //     codeGenerationId,
        //     undefined,
        //     action.folderPath ? { documentation: { type: 'README', scope: action.folderPath } } : undefined
        // )

        await this.cleanCliWorkFolder()
        await this.killCliProcess()

        const workspacePath = this.config.workspaceRoots[0]
        this.qChatProcess = spawn(
            'cd /Volumes/workplace/amazon-q/blueprints/github/q-cli/wade/amazon-q-developer-cli && cargo run --bin q_cli',
            [
                '-- chat',
                '--no-interactive',
                '--accept-all',
                `generate readme file for project workspace ${workspacePath}. The output should be generated in q_tmp folder under the workspace folder`,
            ]
        )

        this.qChatProcess.stdout.on('data', (data) => {
            getLogger().info(`stdout: ${data}`)
        })

        this.qChatProcess.stderr.on('data', (data) => {
            getLogger().error(`stderr: ${data}`)
        })

        this.qChatProcess.on('close', (code) => {
            getLogger().info(`child process exited with code ${code}`)
        })

        this.qChatProcess.on('error', (err) => {
            getLogger().error(err)
        })
    }

    protected override createNextState(config: SessionStateConfig, params: CreateNextStateParams): SessionState {
        return super.createNextState(config, params, DocPreparePocCodeGenState)
    }

    protected async getCliProcessCodeGenerationResult(): Promise<CliProcessCodeGenerationResult> {
        return {
            codeGenerationRemainingIterationCount: 1,
            codeGenerationTotalIterationCount: 1,
            codeGenerationStatus: CodeGenerationStatus.COMPLETE,
            data: {
                newFileContents: [],
                deletedFiles: [],
                references: [],
            },
        }
    }

    protected async killCliProcess(): Promise<void> {
        try {
            if (this.qChatProcess) {
                this.qChatProcess.kill('SIGKILL')
                this.qChatProcess = undefined
            }
        } catch (e: any) {
            getLogger().error('Cannot kill the process')
            getLogger().error(e as Error)
        }
    }

    protected async cleanCliWorkFolder(): Promise<void> {
        const workspacePath = this.config.workspaceRoots[0]

        if (workspacePath) {
            try {
                await fs.promises.rm(workspacePath, { recursive: true, force: true })
                getLogger().info('CLI work folder cleaned successfully')
            } catch (e: any) {
                getLogger().error('Cannot clean directory')
                getLogger().error(e as Error)
            }
        }
    }
}

export class DocPreparePocCodeGenState extends BasePrepareCodeGenState {
    protected preUpload(action: SessionStateAction): void {
        // Do nothing
    }

    protected postUpload(action: SessionStateAction): void {
        // Do nothing
    }

    protected override createNextState(config: SessionStateConfig): SessionState {
        return super.createNextState(config, DocCodeGenPocState)
    }

    protected override async prepareProjectZip(
        workspaceRoots: string[],
        workspaceFolders: CurrentWsFolders,
        span: Span<AmazonqCreateUpload>,
        options: PrepareRepoDataOptions
    ) {
        return await prepareRepoData(workspaceRoots, workspaceFolders, span, {
            ...options,
            isIncludeInfraDiagram: true,
        })
    }
}
