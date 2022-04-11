import { constants } from "fs";
import { access } from "fs/promises";
import { DateTime, Duration } from "luxon";
import path from "path";

import { EncryptedFileWriter } from './EncryptedFile';
import { FileManager } from "./FileManager";
import { LogsProcessor } from "./LogsProcessor";
import { ProcessHandler, Shell } from "./Shell";
import { BackupFile, BackupFileName, Journal } from "./Journal";

export interface FullDumpConfiguration {
    host: string;
    user: string;
    database: string;
}

export interface BackupManagerConfiguration {
    workingDirectory: string;
    logDirectory: string;
    fileManager: FileManager;
    password: string;
    maxDurationSinceLastFullBackup: Duration;
    shell: Shell;
    fullDumpConfiguration: FullDumpConfiguration;
    journalFile: string;
    maxFullBackups: number;
}

export class BackupManager {

    constructor(configuration: BackupManagerConfiguration) {
        this.configuration = configuration;
    }

    private configuration: BackupManagerConfiguration;

    async trigger(date: DateTime) {
        let journal: Journal;
        try {
            await access(this.configuration.journalFile, constants.F_OK);
            journal = await Journal.read(this.configuration.journalFile);
        } catch {
            journal = new Journal();
        }

        let backupFile: BackupFileName;
        let backupFilePath: string;
        const lastFullBackup = journal.getLastFullBackup();
        if(lastFullBackup === undefined
                || date.diff(lastFullBackup.fileName.date) > this.configuration.maxDurationSinceLastFullBackup) {
            backupFile = BackupFileName.getFullBackupFileName(date);
            backupFilePath = path.join(this.configuration.workingDirectory, backupFile.fileName);
            await this.doFullBackup(backupFilePath);
        } else {
            backupFile = BackupFileName.getDeltaBackupFileName(date);
            backupFilePath = path.join(this.configuration.workingDirectory, backupFile.fileName);
            await this.doDeltaBackup(backupFilePath);
        }

        const cid = await this.configuration.fileManager.moveToIpfs(backupFile.fileName);

        journal.addBackup(new BackupFile({cid, fileName: backupFile}));

        const toRemove = journal.keepOnlyLastFullBackups(this.configuration.maxFullBackups);
        for(const file of toRemove) {
            this.configuration.fileManager.removeFileFromIpfs(path.join(this.configuration.workingDirectory, file.fileName.fileName));
        }

        await journal.write(this.configuration.journalFile);
    }

    private async doFullBackup(backupFilePath: string) {
        const writer = new EncryptedFileWriter(this.configuration.password);
        await writer.open(backupFilePath);
        const pgDumpHandler = new PgDumpProcessHandler(writer);
        const fullDumpConfiguration = this.configuration.fullDumpConfiguration;
        const parameters = [
            '-F', 'c',
            '-h', fullDumpConfiguration.host,
            '-U', fullDumpConfiguration.user,
            fullDumpConfiguration.database
        ];
        await this.configuration.shell.spawn("pg_dump", parameters, pgDumpHandler);
        await writer.close();
    }

    private async doDeltaBackup(backupFilePath: string) {
        const writer = new EncryptedFileWriter(this.configuration.password);
        await writer.open(backupFilePath);
        const logsProcessor = new LogsProcessor({
            sqlSink: async (sql) => {
                if(sql) {
                    await writer.write(Buffer.from(sql, 'utf-8'));
                } else {
                    return Promise.resolve();
                }
            },
            filePostProcessor: async (file: string) => await this.configuration.fileManager.deleteFile(file)
        });
        await logsProcessor.process(this.configuration.logDirectory);
        await writer.close();
    }
}

class PgDumpProcessHandler extends ProcessHandler {

    constructor(writer: EncryptedFileWriter) {
        super();
        this.writer = writer;
    }

    private writer: EncryptedFileWriter;

    async onStdOut(data: any) {
        await this.writer.write(data);
    }
}
