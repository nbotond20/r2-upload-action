export interface R2Config {
    accountId: string
    accessKeyId: string
    secretAccessKey: string
    bucket: string
    sourceDir: string
    destinationDir: string
    outputFileUrl: boolean
    cacheControl: string
    batchSize: number
    endpoint?: string
    region?: string
}

export interface FileMap {
    [file: string]: string
}