import {
  createOpportunityReferenceUpload,
  removeOpportunityReferenceUploads,
} from '@/services/opportunityWorkspaceService'
import { validateOpportunityReferenceFile } from '@/utils/opportunityReferenceFiles'
import { uploadSharePointFiles } from '@/services/sharePointUploadService'

export { noteWithReferenceLinks, validateOpportunityReferenceFile } from '@/utils/opportunityReferenceFiles'

export const OPPORTUNITY_FILES_CHANGED_EVENT = 'tag:opportunity-files-changed'

async function rollbackUploadedItems(opportunityKey, uploadedFiles) {
  const itemIds = (uploadedFiles || []).map((file) => file?.id).filter(Boolean)
  for (let index = 0; index < itemIds.length; index += 20) {
    await removeOpportunityReferenceUploads(opportunityKey, itemIds.slice(index, index + 20))
  }
}

export async function uploadOpportunityReferenceFiles(opportunityKey, files, onProgress) {
  return uploadSharePointFiles({
    files,
    prepareUpload: (file) => createOpportunityReferenceUpload(opportunityKey, file),
    rollback: (uploaded) => rollbackUploadedItems(opportunityKey, uploaded),
    validateFile: validateOpportunityReferenceFile,
    onProgress,
  })
}

export async function rollbackOpportunityReferenceFiles(opportunityKey, uploadedFiles) {
  await rollbackUploadedItems(opportunityKey, uploadedFiles)
}

export function announceOpportunityFilesChanged(opportunityKey) {
  window.dispatchEvent(new CustomEvent(OPPORTUNITY_FILES_CHANGED_EVENT, { detail: { opportunityKey } }))
}
