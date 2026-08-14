import {
  createPartnerReferenceUpload,
  removePartnerReferenceUploads,
} from '@/services/partnerWorkspaceService'
import { uploadSharePointFiles } from '@/services/sharePointUploadService'
import { validateOpportunityReferenceFile } from '@/utils/opportunityReferenceFiles'

export const PARTNER_FILES_CHANGED_EVENT = 'tag:partner-files-changed'

async function rollbackUploadedItems(uei, uploadedFiles) {
  const itemIds = (uploadedFiles || []).map((file) => file?.id).filter(Boolean)
  for (let index = 0; index < itemIds.length; index += 20) {
    await removePartnerReferenceUploads(uei, itemIds.slice(index, index + 20))
  }
}

export function uploadPartnerReferenceFiles(uei, files, onProgress) {
  return uploadSharePointFiles({
    files,
    prepareUpload: (file) => createPartnerReferenceUpload(uei, file),
    rollback: (uploaded) => rollbackUploadedItems(uei, uploaded),
    validateFile: validateOpportunityReferenceFile,
    onProgress,
  })
}

export function rollbackPartnerReferenceFiles(uei, uploadedFiles) {
  return rollbackUploadedItems(uei, uploadedFiles)
}

export function announcePartnerFilesChanged(uei) {
  window.dispatchEvent(new CustomEvent(PARTNER_FILES_CHANGED_EVENT, { detail: { uei } }))
}
